import type { EngineInterface, Register } from 'claude-code'

// Public numbers of a few YouTube channels, from the YouTube Data API v3 with an API key:
// subscribers, views and videos. Watch hours need the YouTube Analytics API (OAuth), so they are left out.
const REFRESH_MS = 30 * 60 * 1000
const API = 'https://www.googleapis.com/youtube/v3/channels'
const SUB_GOAL = 1000
const KEEP_DAYS = 40
const DEFAULT_FILE = '~/.claude-mods/channel-stats.json'

/** One channel as the channels file lists it. */
export type ChannelRef = { id?: string; handle?: string; label?: string }

/** A channel's numbers. `subs` is null when the channel hides its subscriber count. */
export type Stats = { title: string; subs: number | null; views: number; videos: number }

/** The last good numbers per channel, keyed by `refKey`, with when they were fetched (ms). */
type Last = Record<string, Stats & { at: number }>
/** Each day's latest numbers, by local date `YYYY-MM-DD`, then by `refKey`. */
type Daily = Record<string, Record<string, { subs: number | null; views: number; videos: number }>>

export const refKey = (r: ChannelRef): string => (r.id ? `id:${r.id}` : `handle:${normHandle(r.handle ?? '').toLowerCase()}`)
const normHandle = (h: string) => (h.startsWith('@') ? h : `@${h}`)

/** The channels file's list, keeping only entries with an `id` (UC...) or a `handle`. */
export const parseChannels = (text: string): ChannelRef[] => {
  let data: unknown
  try { data = JSON.parse(text) } catch { return [] }
  const list = Array.isArray(data) ? data : (data as { channels?: unknown } | null)?.channels
  if (!Array.isArray(list)) return []
  return list.flatMap((x: unknown): ChannelRef[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined
    if (typeof o.id === 'string' && o.id.trim()) return [{ id: o.id.trim(), label }]
    if (typeof o.handle === 'string' && o.handle.trim()) return [{ handle: normHandle(o.handle.trim()), label }]
    return []
  })
}

type ApiItem = {
  id?: string
  snippet?: { title?: string; customUrl?: string }
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean }
}

export const toStats = (item: ApiItem): Stats => {
  const s = item.statistics ?? {}
  return {
    title: item.snippet?.title ?? item.id ?? '',
    subs: s.hiddenSubscriberCount || s.subscriberCount === undefined ? null : Number(s.subscriberCount) || 0,
    views: Number(s.viewCount) || 0,
    videos: Number(s.videoCount) || 0,
  }
}

/** `412`, `18.2k`, `1.3M`. */
export const compact = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`.replace('.0k', 'k')
  return `${(n / 1_000_000).toFixed(1)}M`.replace('.0M', 'M')
}

const signed = (n: number | null) => (n === null ? '' : n > 0 ? `+${n.toLocaleString('en-US')}` : n < 0 ? `-${Math.abs(n).toLocaleString('en-US')}` : '0')
const full = (n: number) => n.toLocaleString('en-US')

const nameOf = (r: ChannelRef, s: Stats | undefined) => r.label ?? s?.title ?? r.handle ?? r.id ?? '?'

/** The status line: `Label 412/1k subs · 18.2k views │ Other 38/1k subs · 2.1k views`. */
export const statusText = (refs: ChannelRef[], last: Last): string => {
  const parts = refs.map(r => {
    const s = last[refKey(r)]
    if (!s) return `${nameOf(r, s)} –`
    const subs = s.subs === null ? 'subs hidden' : `${compact(s.subs)}/${compact(SUB_GOAL)} subs`
    return `${nameOf(r, s)} ${subs} · ${compact(s.views)} views`
  })
  return parts.join(' │ ')
}

/** Local date `YYYY-MM-DD` at `offsetMin` east of UTC. */
export const dayOf = (ms: number, offsetMin: number): string => new Date(ms + offsetMin * 60000).toISOString().slice(0, 10)

/** The `/stats` table: numbers, the change since the latest earlier day kept, and the time of the fetch. */
/** The table as its header line, one line per channel and the notes under it, columns padded for a monospace font. */
export const statsParts = (refs: ChannelRef[], last: Last, daily: Daily, today: string, offsetMin: number, note: string): { head: string; rows: string[]; notes: string[] } => {
  const before = Object.keys(daily).filter(d => d < today).sort().pop()
  const prev = before ? daily[before] ?? {} : {}
  const head = ['Channel', 'Subs', 'to 1k', 'Views', 'Videos']
  const rows = refs.map(r => {
    const k = refKey(r)
    const s = last[k]
    const p = prev[k]
    if (!s) return [nameOf(r, s), '–', '', '–', '–']
    const delta = (now: number | null, then: number | null | undefined) =>
      now === null || then === undefined || then === null ? '' : ` (${signed(now - then)})`
    return [
      nameOf(r, s),
      s.subs === null ? 'hidden' : `${full(s.subs)}${delta(s.subs, p?.subs)}`,
      s.subs === null ? '' : s.subs >= SUB_GOAL ? 'done' : full(SUB_GOAL - s.subs),
      `${full(s.views)}${delta(s.views, p?.views)}`,
      `${full(s.videos)}${delta(s.videos, p?.videos)}`,
    ]
  })
  const all = [head, ...rows]
  const widths = head.map((_, i) => Math.max(...all.map(row => (row[i] ?? '').length)))
  const line = (row: string[]) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join('  ').trimEnd()
  const ats = refs.map(r => last[refKey(r)]?.at).filter((n): n is number => typeof n === 'number')
  const at = ats.length > 0 ? Math.min(...ats) : undefined
  const when = at === undefined ? 'not fetched yet' : `fetched ${new Date(at + offsetMin * 60000).toISOString().slice(0, 16).replace('T', ' ')}`
  return {
    head: line(head),
    rows: rows.map(line),
    notes: [
      `${before ? `Changes since ${before}.` : 'No earlier day kept yet: changes show from tomorrow.'} Numbers ${when}.${note ? ` ${note}` : ''}`,
      'Watch hours are not shown: they need the YouTube Analytics API (OAuth), which an API key cannot reach.',
    ],
  }
}

/** The same table as Markdown text, for a terminal transcript or a log. */
export const statsTable = (refs: ChannelRef[], last: Last, daily: Daily, today: string, offsetMin: number, note: string): string => {
  const p = statsParts(refs, last, daily, today, offsetMin, note)
  return ['```', p.head, ...p.rows, '```', ...p.notes].join('\n')
}

const HINT = 'channel-stats: set a YouTube API key'

/** What a session of the module holds between refreshes. */
type Ctx = { apiKey: string; configured: string; keyFile: string; isRunning?: boolean; offsetMin: number; refs: ChannelRef[]; note: string; inFlight?: Promise<void> }

async function loadRefs($: EngineInterface, ctx: Ctx) {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const path = (ctx.configured || DEFAULT_FILE).replace(/^~(?=\/|$)/, home)
  const text = await $.fs.read(path).then(t => (typeof t === 'string' ? t : '')).catch(() => '')
  return { path, list: parseChannels(text) }
}

async function getChannels($: EngineInterface, apiKey: string, query: string): Promise<{ items: ApiItem[] } | { error: string }> {
  try {
    // the key goes in a header, so it never sits in a URL or a log line
    const res = await $.http.fetch(`${API}?part=statistics,snippet&${query}`, { headers: { 'x-goog-api-key': apiKey, accept: 'application/json' } })
    if (!res.ok) {
      let reason = ''
      try { reason = (JSON.parse(res.text) as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason ?? '' } catch { reason = '' }
      return { error: `HTTP ${res.status}${reason ? ` ${reason}` : ''}` }
    }
    const body = JSON.parse(res.text) as { items?: ApiItem[] }
    return { items: body.items ?? [] }
  } catch {
    return { error: 'network error' }
  }
}

async function fetchAll($: EngineInterface, ctx: Ctx) {
  const { path, list } = await loadRefs($, ctx)
  ctx.refs = list
  if (!ctx.apiKey) {
    $.ui.status(HINT)
    return
  }
  if (list.length === 0) {
    $.ui.status(`channel-stats: no channels in ${path}`)
    return
  }
  const now = await $.clock.now()
  const last = ((await $.store.get('last')) ?? {}) as Last
  const errors: string[] = []

  // every id in one request; a handle needs a request of its own
  const ids = list.flatMap(r => (r.id ? [r.id] : []))
  if (ids.length > 0) {
    const got = await getChannels($, ctx.apiKey, `id=${ids.map(encodeURIComponent).join(',')}`)
    if ('error' in got) errors.push(got.error)
    else {
      for (const item of got.items) if (item.id) last[`id:${item.id}`] = { ...toStats(item), at: now }
      for (const id of ids) if (!got.items.some(x => x.id === id)) errors.push(`no channel ${id}`)
    }
  }
  for (const r of list) {
    if (!r.handle) continue
    const got = await getChannels($, ctx.apiKey, `forHandle=${encodeURIComponent(r.handle)}`)
    const item = 'items' in got ? got.items[0] : undefined
    if (item) last[refKey(r)] = { ...toStats(item), at: now }
    else errors.push('error' in got ? got.error : `no channel ${r.handle}`)
  }
  ctx.note = errors.length > 0 ? `Last refresh failed for some channels (${[...new Set(errors)].join(', ')}); showing the last good numbers.` : ''
  await $.store.set('last', last)

  // each day's latest numbers, for the change since yesterday
  const today = dayOf(now, ctx.offsetMin)
  const daily = ((await $.store.get('daily')) ?? {}) as Daily
  const day = { ...(daily[today] ?? {}) }
  for (const r of list) {
    const s = last[refKey(r)]
    if (s && s.at === now) day[refKey(r)] = { subs: s.subs, views: s.views, videos: s.videos }
  }
  daily[today] = day
  const keep = Object.keys(daily).sort().slice(-KEEP_DAYS)
  await $.store.set('daily', Object.fromEntries(keep.map(d => [d, daily[d] ?? {}])))

  const shown = list.some(r => last[refKey(r)])
  $.ui.status(shown ? statusText(list, last) : `channel-stats: YouTube not reached (${errors[0] ?? 'no data'})`)
}

/** One refresh at a time: a second caller waits on the one running. */
async function refresh($: EngineInterface, ctx: Ctx) {
  if (!ctx.inFlight) {
    ctx.inFlight = fetchAll($, ctx).catch(() => undefined).finally(() => {
      ctx.inFlight = undefined
      // new numbers: an open panel draws them
      $.ui.invalidate('ui.render')
    })
  }
  return ctx.inFlight
}

const PANE = 'channel-stats'

/** `/channel-stats`: fetches if a key is found, then opens the Channel stats panel. */
async function showStats($: EngineInterface, ctx: Ctx) {
  if (!(await ensureKey($, ctx))) {
    return { text: `${HINT}: see the channel-stats README (Google Cloud console, YouTube Data API v3, API key), then save it in ${ctx.keyFile || KEY_FILE} or the mod's settings.` }
  }
  await refresh($, ctx)
  if (ctx.refs.length === 0) return { text: `channel-stats: no channels listed. Add them to ${ctx.configured || DEFAULT_FILE} (see the README).` }
  const opened = await $.ui.open({ id: PANE, title: 'Channel stats' }).catch(() => undefined)
  if (opened?.isPlaced) return { text: 'Channel stats opened.', isTextDisplayOnly: true as const }
  // a surface that cannot show the panel gets the table as text
  return { text: await tableText($, ctx) }
}

async function tableData($: EngineInterface, ctx: Ctx) {
  const last = ((await $.store.get('last')) ?? {}) as Last
  const daily = ((await $.store.get('daily')) ?? {}) as Daily
  const now = await $.clock.now()
  return statsParts(ctx.refs, last, daily, dayOf(now, ctx.offsetMin), ctx.offsetMin, ctx.note)
}

async function tableText($: EngineInterface, ctx: Ctx) {
  const last = ((await $.store.get('last')) ?? {}) as Last
  const daily = ((await $.store.get('daily')) ?? {}) as Daily
  const now = await $.clock.now()
  return statsTable(ctx.refs, last, daily, dayOf(now, ctx.offsetMin), ctx.offsetMin, ctx.note)
}

/**
 * The key from a file, for a mod loaded from a folder (`--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS`), where no
 * settings screen asks for the secret: `~/.claude-mods/youtube-api-key` by default, its first line.
 */
export const KEY_FILE = '~/.claude-mods/youtube-api-key'
async function keyFromFile($: EngineInterface, path: string): Promise<string> {
  const home = path.startsWith('~') ? ((await $.env.get('HOME').catch(() => undefined)) ?? '') : ''
  const full = path.replace(/^~(?=\/|$)/, home)
  const text = await $.fs.read(full).then(t => (typeof t === 'string' ? t : '')).catch(() => '')
  return (text.split('\n')[0] ?? '').trim()
}

/**
 * Finds the key (the setting, else the key file) and, the first time one is found, starts the
 * 30-minute refresh. Runs at session start and again on `/channel-stats`, so a key file saved while
 * a session is open is picked up without restarting it. Returns whether there is a key.
 */
async function ensureKey($: EngineInterface, ctx: Ctx): Promise<boolean> {
  if (!ctx.apiKey) ctx.apiKey = await keyFromFile($, ctx.keyFile || KEY_FILE)
  if (!ctx.apiKey) {
    $.ui.status(HINT)
    return false
  }
  if (!ctx.isRunning) {
    ctx.isRunning = true
    // the module has no time zone of its own: ask the computer once, for the daily snapshot's date
    const tz = await $.process.run(['date', '+%z']).then(r => r.stdout.trim()).catch(() => '')
    const m = /^([+-])(\d\d)(\d\d)/.exec(tz)
    if (m) ctx.offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
    $.clock.every(REFRESH_MS, () => refresh($, ctx))
  }
  return true
}

async function start($: EngineInterface, ctx: Ctx) {
  await $.command.register({ name: 'channel-stats', description: 'YouTube channel subscribers, views and videos, with the change since yesterday' })
  if (await ensureKey($, ctx)) void refresh($, ctx)
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    apiKey: typeof options.apiKey === 'string' ? options.apiKey.trim() : '',
    configured: typeof options.configFile === 'string' ? options.configFile.trim() : '',
    keyFile: typeof options.keyFile === 'string' ? options.keyFile.trim() : '',
    offsetMin: 0,
    refs: [],
    note: '',
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await start($, ctx)
    return result
  })

  on('command.run', { command: 'channel-stats' }, $ => showStats($, ctx))

  // the panel: the table in a monospace font, so its columns line up, and the notes under it
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (!ctx.apiKey) return <Text>{HINT}</Text>
    const t = await tableData($, ctx)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box><Text mono bold>{t.head}</Text></Box>
          {t.rows.map((row, i) => (
            <Box key={`row-${i}`}><Text mono>{row}</Text></Box>
          ))}
        </Box>
        {t.notes.map((n, i) => (
          <Box key={`note-${i}`}><Text dimColor>{n}</Text></Box>
        ))}
      </Box>
    )
  })
}
