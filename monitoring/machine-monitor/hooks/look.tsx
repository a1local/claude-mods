// look.tsx: the shared look of the claude-mods set. Every mod carries an identical copy as hooks/look.tsx
// (each mod installs on its own, so none can import another's); scripts/check-look.sh fails when a copy
// differs from STYLE/look.tsx. Change it here, then copy it to every mod. See STYLE.md.
import type { BoxProps, ButtonProps, ElementConstructor, TextProps } from 'claude-code'

/** The three elements every surface draws, which is all the set uses. */
export type UI = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

/** One coloured piece of a row. `color` is a theme key, so it follows the light and dark themes. */
export type Piece = { text: string; color?: string; bold?: boolean; dim?: boolean }
/** A row is cells side by side; a cell is pieces. Cells in the same position line up across rows. */
export type Cell = Piece[]
export type Row = Cell[]

/** What colours mean, the same in every mod. */
export const TONE = {
  work: 'claude', // in progress: a bar filling, a render running
  good: 'success', // done, healthy, a rise
  warn: 'warning', // close to a limit, due soon
  bad: 'error', // failed, over a limit, overdue, a fall
  info: 'suggestion', // a time to come: an ETA, a scheduled slot
  track: 'inactive', // a bar's empty part
} as const
export type Tone = keyof typeof TONE

/** Colours for named things (channels, projects): the same name always gets the same one. */
const PALETTE = ['success', 'suggestion', 'claude', 'merged', 'warning', 'autoAccept'] as const
export const nameColor = (name: string): string => {
  if (!name) return 'text'
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length] ?? 'text'
}

// --- pieces -----------------------------------------------------------------------------------

export const title = (text: string, color?: string): Piece => ({ text, bold: true, color })
export const num = (text: string, tone?: Tone): Piece => ({ text, bold: true, color: tone ? TONE[tone] : undefined })
export const label = (text: string): Piece => ({ text, dim: true })
export const toned = (text: string, tone: Tone, bold = false): Piece => ({ text, color: TONE[tone], bold })
/** `+12` green, `-3` red, nothing for no change. */
export const change = (n: number | null | undefined): Piece[] =>
  n == null || n === 0 ? [] : [{ text: ` ${n > 0 ? '+' : '-'}${Math.abs(n).toLocaleString('en-US')}`, color: n > 0 ? TONE.good : TONE.bad }]

/** `7.4k`, or the exact number under 1,000. */
export const short = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)
/** `1:05:09`, `05:09`. */
export const clock = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
/** `21:45`: the wall-clock time of `ms` in a time zone `offsetMin` east of UTC (from `date +%z`). */
export const hhmm = (ms: number, offsetMin: number): string => {
  const d = new Date(ms + offsetMin * 60000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
/** `+0800` to 480. */
export const parseOffset = (z: string): number => {
  const m = /^([+-])(\d\d)(\d\d)/.exec(z.trim())
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}
export const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/**
 * The bar: `[####------]`, filled in `tone`, the empty part dim. With `inside`, that text is written in
 * the bar's middle (`[###54%----]`); with no fraction the bar is all dashes, `inside` across it.
 */
export const bar = (fraction: number | null, width = 10, tone: Tone = 'work', inside?: string): Cell => {
  const w = Math.max((inside?.length ?? 0) + 2, width)
  const filled = fraction === null ? 0 : Math.round(Math.min(1, Math.max(0, fraction)) * w)
  const at = inside ? Math.floor((w - inside.length) / 2) : w
  const kind = (i: number) => (inside && i >= at && i < at + inside.length ? 'in' : i < filled ? 'fill' : 'empty')
  const out: Piece[] = [{ text: '[', dim: true }]
  for (let i = 0; i < w; ) {
    let j = i
    while (j < w && kind(j) === kind(i)) j += 1
    const k = kind(i)
    out.push(k === 'in'
      ? { text: (inside ?? '').slice(i - at, j - at), bold: true }
      : { text: (k === 'fill' ? '#' : '-').repeat(j - i), color: k === 'fill' ? TONE[tone] : TONE.track, dim: k === 'empty' && fraction === null })
    i = j
  }
  out.push({ text: ']', dim: true })
  return out
}

// --- layout ------------------------------------------------------------------------------------

const cellText = (c: Cell) => c.map(p => p.text).join('')

/**
 * Lines the rows' cells up: each cell padded to its column's widest, numbers (`align` 'right') on
 * the right. Returns each row as one list of pieces, two spaces between columns.
 */
export const align = (rows: Row[], right: readonly number[] = []): Piece[][] => {
  const widths: number[] = []
  for (const row of rows) row.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, cellText(c).length) })
  return rows.map(row => row.flatMap((c, i) => {
    const pad = ' '.repeat((widths[i] ?? 0) - cellText(c).length)
    const sep: Piece[] = i > 0 ? [{ text: '  ' }] : []
    const last = i === row.length - 1
    return right.includes(i) ? [...sep, { text: pad }, ...c] : [...sep, ...c, ...(last ? [] : [{ text: pad }])]
  }))
}

/** A row as plain text, for the text a command answers (what a terminal transcript and the model read). */
export const plain = (pieces: Piece[]): string => pieces.map(p => p.text).join('').trimEnd()

/** One line of pieces, never wrapping. */
export const line = (ui: UI, pieces: Piece[], key?: string) => (
  <ui.Box key={key} flexDirection="row" flexWrap="nowrap">
    {pieces.map(p => <ui.Text mono color={p.color} bold={p.bold} dimColor={p.dim} wrap="truncate-end">{p.text}</ui.Text>)}
  </ui.Box>
)

/** A command's reply: a rounded box, a bold title, one line per row, a footnote, dim unless `footTone` colours it (drawn by replyBox). */
export type Reply = { title: string; rows: Piece[][]; foot?: string; footTone?: Tone; empty?: string }

export const replyBox = (ui: UI, reply: Reply) => (
  <ui.Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
    <ui.Box><ui.Text bold>{reply.title}</ui.Text></ui.Box>
    {reply.rows.length === 0 && reply.empty ? <ui.Box><ui.Text dimColor>{reply.empty}</ui.Text></ui.Box> : null}
    {reply.rows.map((pieces, i) => line(ui, pieces, `row-${i}`))}
    {reply.foot ? (
      <ui.Box key="foot">
        <ui.Text size="footnote" dimColor={!reply.footTone} color={reply.footTone ? TONE[reply.footTone] : undefined}>{reply.foot}</ui.Text>
      </ui.Box>
    ) : null}
  </ui.Box>
)

/** The same reply as text: what the command answers, read by a terminal transcript and the model. */
export const replyText = (reply: Reply): string =>
  [reply.title, ...(reply.rows.length === 0 && reply.empty ? [reply.empty] : reply.rows.map(plain)), ...(reply.foot ? [reply.foot] : [])].join('\n')

/**
 * Replies by their text, so a mod's `CommandOutput` hook can draw the reply it just answered with
 * replyBox. A text not in the map (an old row after a reload) is drawn as the plain text it is.
 */
const replies = new Map<string, Reply>()
export const remember = (reply: Reply): string => {
  const text = replyText(reply)
  replies.set(text, reply)
  if (replies.size > 50) replies.delete(replies.keys().next().value as string)
  return text
}
export const recall = (text: string): Reply | undefined => replies.get(text.replace(/^[\w-]+:\s*/, '')) ?? replies.get(text)

/** One line of a band above the prompt: the text on the left, a ✕ at the right end (the band's own padding after it) that calls `onClose`. */
export const bandLine = (ui: UI, id: string, pieces: Piece[], onClose: () => void) => (
  <ui.Box key={id} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="center" width="100%">
    {line(ui, pieces)}
    <ui.Button key={`close-${id}`} label="✕" onPress={onClose} />
  </ui.Box>
)

/** A status line: `label value · label value`. */
export const status = (parts: readonly (readonly [string, string])[]): string =>
  parts.map(([l, v]) => (l ? `${l} ${v}` : v)).join(' · ')
