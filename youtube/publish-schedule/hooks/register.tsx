import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { align, cut, deckRow, hhmm, label, nameColor, NO_VIEW, num, parseOffset, RANK, readDecks, recall, remember, replyBox, title, toned } from './look'
import type { Cell, DeckItem, Piece, Reply } from './look'
import type { Row, ScheduleItem, Status } from '../types'

// The schedule lives in one JSON file (default ~/.claude-mods/schedule.json): a list of
// `{ at, channel, kind, title, done?, scheduled?, platforms?, color? }`. See README.md. Read every minute.
const POLL_MS = 60 * 1000
const SOON_MS = 60 * 60 * 1000
const EARLIER_DAYS = 7 // overdue items this many days back still show, under "Earlier, not done"
const TITLE_MAX = 40
const BAND_TITLE_MAX = 28 // the band's line is short; the full title is in /publishing

const rows = atom({ plugin: 'publish-schedule', key: 'rows' } as const, [])
const nowAtom = atom({ plugin: 'publish-schedule', key: 'nowMs' } as const, 0)
const offsetAtom = atom({ plugin: 'publish-schedule', key: 'offsetMin' } as const, 0)
const problemAtom = atom({ plugin: 'publish-schedule', key: 'problem' } as const, '')
// this mod's items on the one row above the prompt the set shares, and its view of that row
const deckAtom = atom({ plugin: 'publish-schedule', key: 'deck' } as const, { items: [], reset: 0 })
const viewAtom = atom({ plugin: 'publish-schedule', key: 'view' } as const, NO_VIEW)
let bandOn = true // the `band` setting

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
    color: typeof o.color === 'string' && o.color.trim() ? o.color.trim() : undefined,
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

/** The status and its tone: done good, due within the hour warn, overdue bad, scheduled info, later dim. */
export const statusPiece = (r: Row, nowMs: number): Piece => {
  const s = statusOf(r, nowMs)
  return s === 'done' ? toned('done', 'good')
    : s === 'overdue' ? toned(`overdue ${span(nowMs - r.atMs)}`, 'bad', true)
    : s === 'soon' ? toned(`in ${span(r.atMs - nowMs)}`, 'warn')
    : r.scheduled ? toned('scheduled', 'info')
    : label('later')
}

const PLATFORM_SHORT: Record<string, string> = { youtube: 'YT', facebook: 'FB', tiktok: 'TT', instagram: 'IG' }
export const platformsText = (ps: string[] | undefined): string =>
  (ps ?? []).map(p => PLATFORM_SHORT[p.toLowerCase()] ?? p).join(' ')

const kindText = (k: ScheduleItem['kind']) => (k === 'film' ? 'Film' : 'Short')

/** The channel, bold, in the entry's own `color`, else the set's steady colour for the name. */
const channelPiece = (r: Row): Piece => title(r.channel, r.color ?? nameColor(r.channel))

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

/** The rows the reply shows, in the order it numbers them (1, 2, ...). */
export const shownRows = (all: Row[], nowMs: number, offsetMin: number): Row[] =>
  groups(all, nowMs, offsetMin).flatMap(g => g.rows)

/**
 * `/publishing`'s reply in the set's look: a dim line per day, then one numbered line per item (time,
 * channel in its colour, kind, title, platforms, status by tone), and a footnote with the counts.
 * `readMs` is when the file was last read; `note` leads the footnote (`marked 2 done`).
 */
export const scheduleReply = (all: Row[], nowMs: number, offsetMin: number, readMs: number, problem = '', note = ''): Reply => {
  const gs = groups(all, nowMs, offsetMin).filter(g => g.rows.length > 0)
  const items = gs.flatMap(g => g.rows)
  const cells = items.map((r, i): Cell[] => [
    [num(`${i + 1}.`)],
    [{ text: hhmm(r.atMs, offsetMin) }],
    [channelPiece(r)],
    [{ text: kindText(r.kind) }],
    [{ text: cut(r.title, TITLE_MAX), dim: statusOf(r, nowMs) === 'done' }],
    [label(platformsText(r.platforms))],
    [statusPiece(r, nowMs)],
  ])
  // the item lines share columns; the day lines sit between them, outside the columns
  const lines = align(cells, [0])
  const out: Piece[][] = []
  let i = 0
  for (const g of gs) {
    out.push([label(g.label)])
    for (let k = 0; k < g.rows.length; k += 1) out.push(lines[i++] ?? [])
  }
  const today = dayKey(nowMs, offsetMin)
  const dueToday = items.filter(r => dayKey(r.atMs, offsetMin) === today && ['soon', 'later'].includes(statusOf(r, nowMs))).length
  const overdue = items.filter(r => statusOf(r, nowMs) === 'overdue').length
  const counts = [`${dueToday} due today`, ...(overdue > 0 ? [`${overdue} overdue`] : []), `updated ${hhmm(readMs || nowMs, offsetMin)}`]
  return {
    title: 'Publishing',
    rows: out,
    foot: [...(note ? [note] : []), ...(problem ? [] : counts)].join(' · ') || undefined,
    empty: problem || 'Nothing to publish today or tomorrow.',
  }
}

/** The band's rows: what is overdue or due within the hour. */
export const bandRows = (all: Row[], nowMs: number, offsetMin: number): Row[] =>
  shownRows(all, nowMs, offsetMin).filter(r => {
    const s = statusOf(r, nowMs)
    return s === 'overdue' || s === 'soon'
  })

/** The band's rows as items of the shared row: overdue ranks with failures, due soon after renders. */
export const deckOf = (all: Row[], nowMs: number, offsetMin: number): DeckItem[] => {
  const list = bandRows(all, nowMs, offsetMin)
  const lines = bandPieces(list, nowMs, offsetMin)
  return list.map((r, i) => ({ id: r.id, rank: statusOf(r, nowMs) === 'overdue' ? RANK.bad : RANK.warn, pieces: lines[i] ?? [] }))
}

/** `38m`, `2h5m`, `2h`: the short span the band uses. */
export const tightSpan = (ms: number): string => span(ms).replace(/ h ?/, 'h').replace(' min', 'm')

/**
 * One band line per row, short (less is more): when, in the status colour (`in 38m`, `late 2h5m`),
 * the channel in its colour, and the title cut short. The time and kind stay in `/publishing`.
 */
export const bandPieces = (list: Row[], nowMs: number, _offsetMin: number): Piece[][] =>
  align(list.map(r => [
    [statusOf(r, nowMs) === 'overdue' ? toned(`late ${tightSpan(nowMs - r.atMs)}`, 'bad', true) : toned(`in ${tightSpan(r.atMs - nowMs)}`, 'warn')],
    [channelPiece(r)],
    [{ text: cut(r.title, BAND_TITLE_MAX) }],
  ]))

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
  const items = bandOn ? deckOf(found, nowMs, offsetMin) : []
  await update($, deckAtom, d => ({ items, reset: d.reset || 0 }))
}

/** Set `done: true` on the entry `id` names, in the file as it is now, and read it again. */
export const markDone = async ($: EngineInterface, file: string, id: string): Promise<boolean> => {
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
  return changed
}

/**
 * What a session of the module holds: the schedule file, and the ids of the rows the last reply
 * numbered, so `/publishing done 2` means the row shown as 2.
 */
type Ctx = { file: string; numbered: string[] }

/** The reply as text, remembered so the `CommandOutput` hook can draw it as the box. */
async function answer($: EngineInterface, ctx: Ctx, note = '') {
  const all = await read($, rows)
  const offsetMin = await read($, offsetAtom)
  const nowMs = await $.clock.now()
  ctx.numbered = shownRows(all, nowMs, offsetMin).map(r => r.id)
  return { text: remember(scheduleReply(all, nowMs, offsetMin, await read($, nowAtom), await read($, problemAtom), note)) }
}

/** `/publishing done <n>`: marks the row numbered n in the last reply done, then answers the reply again. */
async function markRow($: EngineInterface, ctx: Ctx, n: number) {
  // numbered as the last reply showed them; with no reply yet this session, as one would now
  if (ctx.numbered.length === 0) ctx.numbered = shownRows(await read($, rows), await $.clock.now(), await read($, offsetAtom)).map(r => r.id)
  const id = ctx.numbered[n - 1]
  if (!id || !ctx.file) return { text: `publishing: no row ${n}. Rows run 1 to ${ctx.numbered.length}; /publishing lists them.` }
  const changed = await markDone($, ctx.file, id).catch(() => false)
  if (!changed) return { text: `publishing: could not mark row ${n} done in ${ctx.file}.` }
  return answer($, ctx, `marked ${n} done`)
}

export const register: Register = (on, options) => {
  const ctx: Ctx = { file: '', numbered: [] }
  bandOn = options.band !== 'off'

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'publishing', description: "Today's and tomorrow's films and Shorts to publish; /publishing done <n> marks row n done" })
    // the module has no time zone or home folder of its own: ask the computer once
    const z = await $.process.run(['date', '+%z']).then(r => r.stdout.trim()).catch(() => '')
    if (/^[+-]\d{4}/.test(z)) await update($, offsetAtom, () => parseOffset(z))
    const configured = typeof options.scheduleFile === 'string' ? options.scheduleFile.trim() : ''
    const home = await homeOf($)
    ctx.file = (configured || '~/.claude-mods/schedule.json').replace(/^~(?=\/|$)/, home)
    await poll($, ctx.file)
    $.clock.every(POLL_MS, () => poll($, ctx.file))
    return result
  })

  on('command.run', { command: 'publishing' }, async ($, e) => {
    if (ctx.file) await poll($, ctx.file)
    const args = (e.args ?? '').trim()
    const done = /^done\s+(\d+)$/i.exec(args)
    if (done) return markRow($, ctx, Number(done[1]))
    if (args) return { text: 'publishing: /publishing lists the schedule; /publishing done <n> marks row n done.' }
    // the command also brings back band lines closed with ✕
    await update($, deckAtom, d => ({ ...d, reset: (d.reset || 0) + 1 }))
    return answer($, ctx)
  })

  // the reply in the chat, drawn in the set's look (see STYLE/STYLE.md)
  on('ui.render', { component: 'CommandOutput', props: { command: 'publishing' } }, async ($, e, next) => {
    const reply = e.props.isErrored ? undefined : recall(e.props.text)
    return reply ? replyBox($.ui.resolve(e), reply) : next(e)
  })

  // the one row above the prompt the set shares (see STYLE/look.tsx): uploads due and anything else
  // running, most urgent first, ‹ 2/3 › across them all, ✕ closes the one in view
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const row = deckRow($.ui.resolve(e), 'publish-schedule', await readDecks($), await read($, viewAtom), fn => { void update($, viewAtom, fn) })
    return row ?? next(e)
  })
}
