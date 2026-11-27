import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Row, ScheduleItem, Status } from '../types'

// The schedule lives in one JSON file (default ~/.claude-mods/schedule.json): a list of
// `{ at, channel, kind, title, done?, scheduled?, platforms? }`. See README.md. Read every minute.
const PANE = 'publish-schedule'
const PANE_TITLE = 'Publishing'
const POLL_MS = 60 * 1000
const SOON_MS = 60 * 60 * 1000
const EARLIER_DAYS = 7 // overdue items this many days back still show, under "Earlier"

const rows = atom({ plugin: 'publish-schedule', key: 'rows' } as const, [])
const nowAtom = atom({ plugin: 'publish-schedule', key: 'nowMs' } as const, 0)
const offsetAtom = atom({ plugin: 'publish-schedule', key: 'offsetMin' } as const, 0)
const problemAtom = atom({ plugin: 'publish-schedule', key: 'problem' } as const, '')

/** `2026-11-28T14:00` (local, `offsetMin` east of UTC) as epoch ms, or NaN. */
export const localMs = (at: string, offsetMin: number): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(at.trim())
  if (!m) return NaN
  const [y, mo, d, h, mi, s] = m.slice(1).map(x => Number(x ?? 0)) as [number, number, number, number, number, number]
  return Date.UTC(y, mo - 1, d, h, mi, s) - offsetMin * 60000
}

const local = (ms: number, offsetMin: number) => new Date(ms + offsetMin * 60000)

/** The local day, `2026-11-28`. */
export const dayKey = (ms: number, offsetMin: number): string => local(ms, offsetMin).toISOString().slice(0, 10)

/** The local time, `14:00`. */
export const hhmm = (ms: number, offsetMin: number): string => local(ms, offsetMin).toISOString().slice(11, 16)

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayLabel = (ms: number, offsetMin: number) => {
  const d = local(ms, offsetMin)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export const rowId = (item: ScheduleItem): string => `${item.at}|${item.channel}|${item.title}`

/** The file's entries: a JSON list, or an object holding one under `items`. */
const entriesOf = (data: unknown): unknown[] =>
  Array.isArray(data) ? data
    : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items
    : []

const asItem = (x: unknown): ScheduleItem | undefined => {
  if (!x || typeof x !== 'object') return undefined
  const o = x as Record<string, unknown>
  if (typeof o.at !== 'string' || typeof o.title !== 'string') return undefined
  return {
    at: o.at,
    channel: typeof o.channel === 'string' ? o.channel : '',
    kind: o.kind === 'film' ? 'film' : 'short',
    title: o.title,
    done: o.done === true,
    scheduled: o.scheduled === true,
    platforms: Array.isArray(o.platforms) ? o.platforms.filter((p): p is string => typeof p === 'string') : undefined,
  }
}

/** Parse the schedule file's text into rows in time order. */
export const parseSchedule = (text: string, offsetMin: number): Row[] => {
  const out: Row[] = []
  for (const x of entriesOf(JSON.parse(text))) {
    const item = asItem(x)
    if (!item) continue
    const atMs = localMs(item.at, offsetMin)
    if (Number.isFinite(atMs)) out.push({ ...item, id: rowId(item), atMs })
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.channel.localeCompare(b.channel) || a.title.localeCompare(b.title))
}

/** Done (by hand, or scheduled and past its time), overdue, due within the hour, or later. */
export const statusOf = (r: Row, nowMs: number): Status =>
  r.done || (r.scheduled && r.atMs <= nowMs) ? 'done'
    : r.atMs <= nowMs ? 'overdue'
    : r.atMs - nowMs <= SOON_MS ? 'soon'
    : 'later'

/** `25 min`, `2 h 5 min`. */
export const span = (ms: number): string => {
  const min = Math.max(0, Math.round(Math.abs(ms) / 60000))
  const h = Math.floor(min / 60)
  return h > 0 ? `${h} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`
}

const STATUS_COLOR: Record<Status, string> = { done: 'success', overdue: 'error', soon: 'warning', later: 'subtle' }

export const statusText = (r: Row, nowMs: number): string => {
  const s = statusOf(r, nowMs)
  return s === 'done' ? 'done'
    : s === 'overdue' ? `overdue ${span(nowMs - r.atMs)}`
    : s === 'soon' ? `in ${span(r.atMs - nowMs)}`
    : 'later'
}

const PLATFORM_SHORT: Record<string, string> = { youtube: 'YT', facebook: 'FB', tiktok: 'TT', instagram: 'IG' }
export const platformsText = (ps: string[] | undefined): string =>
  (ps ?? []).map(p => PLATFORM_SHORT[p.toLowerCase()] ?? p).join(' ')

const kindText = (k: ScheduleItem['kind']) => (k === 'film' ? 'Film' : 'Short')

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

/** A channel's colour: the same name always gets the same theme colour. */
const PALETTE = ['suggestion', 'claude', 'merged', 'autoAccept', 'planMode']
export const channelColor = (channel: string): string => {
  if (!channel) return 'text'
  let h = 0
  for (const ch of channel) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length] ?? 'text'
}

export type Group = { key: string; label: string; rows: Row[] }

/** Today's and tomorrow's rows, and any still overdue from the last week, by day. */
export const groups = (all: Row[], nowMs: number, offsetMin: number): Group[] => {
  const today = dayKey(nowMs, offsetMin)
  const tomorrowMs = nowMs + 24 * 60 * 60 * 1000
  const tomorrow = dayKey(tomorrowMs, offsetMin)
  const earlier = all.filter(r => dayKey(r.atMs, offsetMin) < today && nowMs - r.atMs <= EARLIER_DAYS * 86400000 && statusOf(r, nowMs) === 'overdue')
  const out: Group[] = []
  if (earlier.length > 0) out.push({ key: 'earlier', label: 'Earlier, not done', rows: earlier })
  out.push({ key: today, label: `Today, ${dayLabel(nowMs, offsetMin)}`, rows: all.filter(r => dayKey(r.atMs, offsetMin) === today) })
  out.push({ key: tomorrow, label: `Tomorrow, ${dayLabel(tomorrowMs, offsetMin)}`, rows: all.filter(r => dayKey(r.atMs, offsetMin) === tomorrow) })
  return out
}

/** The band's one line, or undefined when nothing is overdue or due within the hour. */
export const bandLine = (all: Row[], nowMs: number, offsetMin: number, width = 100): { lead: string; text: string; when: string; color: string } | undefined => {
  const shown = groups(all, nowMs, offsetMin).flatMap(g => g.rows)
  const overdue = shown.filter(r => statusOf(r, nowMs) === 'overdue')
  const soon = shown.filter(r => statusOf(r, nowMs) === 'soon')
  const pick = overdue[0] ?? soon[0]
  if (!pick) return undefined
  const more = overdue.length + soon.length - 1
  const lead = overdue.length > 0 ? 'Overdue:' : 'Next:'
  const when = `(${overdue.length > 0 ? `${span(nowMs - pick.atMs)} ago` : `in ${span(pick.atMs - nowMs)}`})${more > 0 ? ` +${more} more` : ''}`
  const head = `${kindText(pick.kind)} ${hhmm(pick.atMs, offsetMin)}${pick.channel ? ` ${pick.channel}` : ''} `
  const room = Math.max(12, width - lead.length - head.length - when.length - 6)
  return { lead, text: `${head}"${cut(pick.title, room)}"`, when, color: overdue.length > 0 ? 'error' : 'warning' }
}

const homeOf = async ($: EngineInterface) =>
  $.process.run(['printenv', 'HOME']).then(r => r.stdout.trim()).catch(() => '')

const poll = async ($: EngineInterface, file: string) => {
  const nowMs = await $.clock.now()
  const offsetMin = await read($, offsetAtom)
  let found: Row[] = []
  let problem = ''
  const text = await $.fs.read(file).then(t => (typeof t === 'string' ? t : '')).catch(() => undefined)
  if (text === undefined) problem = `No schedule file at ${file}`
  else {
    try {
      found = parseSchedule(text, offsetMin)
    } catch {
      problem = `${file} is not valid JSON`
    }
  }
  await update($, rows, () => found)
  await update($, problemAtom, () => problem)
  await update($, nowAtom, () => nowMs)
}

/** Set `done: true` on the entry `id` names, in the file as it is now, and read it again. */
export const markDone = async ($: EngineInterface, file: string, id: string) => {
  const text = await $.fs.read(file).then(t => (typeof t === 'string' ? t : ''))
  const data: unknown = JSON.parse(text)
  let changed = false
  for (const x of entriesOf(data)) {
    const item = asItem(x)
    if (item && rowId(item) === id && x && typeof x === 'object') {
      ;(x as Record<string, unknown>).done = true
      changed = true
    }
  }
  if (changed) await $.fs.write(file, `${JSON.stringify(data, null, 2)}\n`)
  await poll($, file)
}

export const register: Register = (on, options) => {
  let file = ''
  const bandOn = options.band !== 'off'

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'publishing', description: "Show today's and tomorrow's films and Shorts to publish" })
    // the module has no time zone or home folder of its own: ask the computer once
    const z = await $.process.run(['date', '+%z']).then(r => r.stdout.trim()).catch(() => '')
    const m = /^([+-])(\d\d)(\d\d)/.exec(z)
    if (m) await update($, offsetAtom, () => (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])))
    const configured = typeof options.scheduleFile === 'string' ? options.scheduleFile.trim() : ''
    const home = await homeOf($)
    file = (configured || '~/.claude-mods/schedule.json').replace(/^~(?=\/|$)/, home)
    await poll($, file)
    $.clock.every(POLL_MS, () => poll($, file))
    return result
  })

  on('command.run', { command: 'publishing' }, async $ => {
    if (file) await poll($, file)
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: 'Publishing pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, rows)
    const problem = await read($, problemAtom)
    const offsetMin = await read($, offsetAtom)
    const nowMs = await $.clock.now()
    const gs = groups(all, nowMs, offsetMin)
    const shown = gs.flatMap(g => g.rows)
    const chW = Math.max(0, ...shown.map(r => r.channel.length))
    const titleW = Math.max(20, (e.props.bodyColumns ?? 80) - chW - 40)

    return (
      <Box flexDirection="column">
        {problem ? <Text color="error">{problem}</Text> : null}
        {!problem && shown.length === 0 ? <Text dimColor>Nothing to publish today or tomorrow.</Text> : null}
        {gs.filter(g => g.rows.length > 0).map(g => (
          <Box key={g.key} flexDirection="column" marginTop={1}>
            <Text bold>{g.label}</Text>
            {g.rows.map(r => {
              const s = statusOf(r, nowMs)
              return (
                <Box key={r.id} flexDirection="row" flexWrap="wrap" columnGap={1}>
                  <Text mono>{hhmm(r.atMs, offsetMin)}</Text>
                  <Text mono color={channelColor(r.channel)}>{r.channel.padEnd(chW)}</Text>
                  <Text mono>{kindText(r.kind).padEnd(5)}</Text>
                  <Text dimColor={s === 'done'}>{cut(r.title, titleW)}</Text>
                  {r.platforms && r.platforms.length > 0 ? <Text mono color="subtle">{platformsText(r.platforms)}</Text> : null}
                  <Text mono color={STATUS_COLOR[s]} bold={s === 'overdue'}>{statusText(r, nowMs)}</Text>
                  {s !== 'done' && file ? (
                    <Button key={`done:${r.id}`} label="Done" dimColor onPress={() => markDone($, file, r.id)} />
                  ) : null}
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!bandOn || e.props.hasSurvey) return next(e)
    const line = bandLine(await read($, rows), await $.clock.now(), await read($, offsetAtom), e.props.bodyColumns)
    if (!line) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="publish-next" flexDirection="row" columnGap={1}>
        <Text mono bold color={line.color}>{line.lead}</Text>
        <Text>{line.text}</Text>
        <Text mono color={line.color}>{line.when}</Text>
      </Box>
    )
  })
}
