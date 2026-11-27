import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RenderRow } from '../types'

// Each render describes itself in one small file in the registry folder (default ~/.render-progress):
// `key=value` lines. See README.md for the format. The mod reads them every few seconds.
const POLL_MS = 3000
const COMMAND_EVERY_MS = 15000 // a `kind=command` render's command runs at most this often
const STALL_SEC = 15 * 60 // no log written for this long while rendering
const KEEP_DONE_SEC = 2 * 60 * 60 // a finished render stays this long, unless hidden
const IGNORE_OLDER_SEC = 2 * 24 * 60 * 60

const rows = atom({ plugin: 'render-progress', key: 'rows' } as const, [])
const hidden = atom({ plugin: 'render-progress', key: 'hidden' } as const, [])

/** Parse a registry file's `key=value` lines. */
export const parseRegistry = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** The last "Rendered N/M" a Remotion log printed: frames done, and frames in that part. */
export const lastRendered = (tail: string): { done: number; of: number } => {
  const all = [...tail.matchAll(/Rendered (\d+)\/(\d+)/g)]
  const last = all[all.length - 1]
  return last ? { done: Number(last[1]), of: Number(last[2]) } : { done: 0, of: 0 }
}

const readText = async ($: EngineInterface, path: string) =>
  $.fs.read(path).then(t => (typeof t === 'string' ? t : '')).catch(() => '')

const readTail = async ($: EngineInterface, path: string, bytes: number) => {
  const st = await $.fs.stat(path).catch(() => undefined)
  if (!st) return { text: '', mtimeMs: 0 }
  const offset = Math.max(0, st.size - bytes)
  const text = await $.fs.read(path, { offset, length: st.size - offset }).catch(() => '')
  return { text: typeof text === 'string' ? text : '', mtimeMs: st.mtimeMs }
}

type Base = Pick<RenderRow, 'id' | 'title' | 'channel' | 'color'>

/**
 * `kind=remotion` (a work dir holding `status` and `part*.log` from `remotion render`, logged without
 * `--log=error`) and `kind=lambda` (`status` and `lambda.log` from a Remotion Lambda render).
 * `status` lines the mod reads: `partN ok`, `audio ok`, `site <url>`, `video ok`, `DONE <file>`, `FAILED`.
 */
const workDirRow = async ($: EngineInterface, base: Base, reg: Record<string, string>, nowSec: number): Promise<RenderRow | undefined> => {
  const work = reg.work
  const start = Number(reg.start)
  if (!work || !Number.isFinite(start) || nowSec - start > IGNORE_OLDER_SEC) return undefined
  const kind = reg.kind === 'lambda' ? 'lambda' : 'remotion'
  const framesTotal = Number(reg.frames) || 0

  const status = await readTail($, `${work}/status`, 4096)
  const lines = status.text.split('\n')
  const has = (re: RegExp) => lines.some(l => re.test(l))
  let lastWrite = status.mtimeMs

  let framesDone = 0
  let partsStarted = false
  if (kind === 'remotion') {
    const parts = (await $.fs.list(work).catch(() => []))
      .map(e => /^part(\d+)\.log$/.exec(e.name)?.[1])
      .filter((n): n is string => n !== undefined)
    for (const n of parts) {
      const tail = await readTail($, `${work}/part${n}.log`, 600)
      if (tail.mtimeMs) partsStarted = true
      lastWrite = Math.max(lastWrite, tail.mtimeMs)
      const seen = lastRendered(tail.text)
      // a finished part counts all its frames
      framesDone += has(new RegExp(`^part${n} ok`)) ? seen.of || Math.floor(framesTotal / parts.length) : seen.done
    }
  } else {
    const log = await readTail($, `${work}/lambda.log`, 200)
    lastWrite = Math.max(lastWrite, log.mtimeMs)
  }

  let stage: RenderRow['stage']
  if (has(/^DONE/)) stage = 'done'
  else if (has(/FAILED/)) stage = 'failed'
  else if (kind === 'remotion') {
    const partLines = lines.filter(l => /^part\d+ ok/.test(l)).length
    const partFiles = (await $.fs.list(work).catch(() => [])).filter(e => /^part\d+\.log$/.test(e.name)).length
    stage = partFiles > 0 && partLines >= partFiles ? 'joining' : partsStarted ? 'rendering' : 'bundling'
  } else {
    stage = has(/^video ok/) ? 'joining' : has(/^site /) ? 'rendering' : (await $.fs.exists(`${work}/site.log`)) ? 'uploading' : 'bundling'
  }
  if ((stage === 'rendering' || stage === 'joining') && lastWrite > 0 && nowSec - lastWrite / 1000 > STALL_SEC) stage = 'stalled'
  if ((stage === 'done' || stage === 'failed') && nowSec - status.mtimeMs / 1000 > KEEP_DONE_SEC) return undefined

  const fraction = kind === 'remotion' && framesTotal > 0 && stage !== 'bundling'
    ? Math.min(1, framesDone / framesTotal)
    : stage === 'done' ? 1 : null
  const elapsedSec = nowSec - start
  const leftSec = fraction !== null && fraction > 0.02 && fraction < 1 && stage === 'rendering'
    ? (elapsedSec * (1 - fraction)) / fraction // includes bundling; good enough for a rate
    : null
  return {
    ...base, kind, stage, fraction, framesDone, framesTotal, leftSec,
    elapsedSec: stage === 'done' || stage === 'failed' ? status.mtimeMs / 1000 - start : elapsedSec,
  }
}

/**
 * `kind=command`: `cmd` (run with `sh -c` in `cwd`) prints one line of JSON,
 * `{"total": n, "done": n, "running": bool, "started": epochSeconds?, "finished": epochSeconds?, "pids": [n]?}`.
 * Shown while `running`; the time left comes from how fast `done` rose over the last 10 minutes.
 */
type CommandData = { total: number; done: number; running: boolean; started?: number | null; finished?: number | null; pids?: number[] }
type Sample = { atSec: number; done: number }
const commandCache = new Map<string, { at: number; data: CommandData | undefined; samples: Sample[]; doneAt?: number }>()

export const commandRow = (base: Base, data: CommandData, samples: Sample[], nowSec: number, doneAtSec?: number): RenderRow | undefined => {
  if (data.total <= 0) return undefined
  const elapsedSec = (until: number) => (data.started ? Math.max(0, until - data.started) : 0)
  // every frame there: done, shown green until KEEP_DONE_SEC after it was first seen complete
  if (data.done >= data.total) {
    // when it finished: the command's own `finished` (say, the newest frame's time), else when first seen complete
    const at = data.finished ?? doneAtSec ?? nowSec
    if (nowSec - at > KEEP_DONE_SEC) return undefined
    return {
      ...base, kind: 'command', stage: 'done', fraction: 1, framesDone: data.total, framesTotal: data.total,
      elapsedSec: elapsedSec(at), leftSec: null,
    }
  }
  if (!data.running) return undefined
  const first = samples[0]
  const last = samples[samples.length - 1]
  const perSec = first && last && last.atSec > first.atSec ? (last.done - first.done) / (last.atSec - first.atSec) : 0
  return {
    ...base, kind: 'command', stage: 'rendering',
    fraction: Math.min(1, data.done / data.total), framesDone: data.done, framesTotal: data.total,
    elapsedSec: elapsedSec(nowSec),
    leftSec: perSec > 0 ? (data.total - data.done) / perSec : null,
  }
}

const runCommand = async ($: EngineInterface, id: string, reg: Record<string, string>, nowMs: number) => {
  const cached = commandCache.get(id) ?? { at: 0, data: undefined, samples: [] }
  if (nowMs - cached.at >= COMMAND_EVERY_MS && reg.cmd) {
    const res = await $.process.run(['sh', '-c', reg.cmd], { cwd: reg.cwd || undefined, timeoutMs: 20000 }).catch(() => undefined)
    let data: CommandData | undefined
    try { data = res && res.exitCode === 0 ? JSON.parse(res.stdout) : undefined } catch { data = undefined }
    cached.data = data
    if (data) {
      const atSec = nowMs / 1000
      // when the render was first seen complete; cleared if frames go missing again (a re-render)
      cached.doneAt = data.total > 0 && data.done >= data.total ? cached.doneAt ?? atSec : undefined
      cached.samples = [...cached.samples, { atSec, done: data.done }].filter(s => atSec - s.atSec <= 600)
    }
    cached.at = nowMs
    commandCache.set(id, cached)
  }
  return cached
}

export type Proc = { pid: number; ppid: number; cpu: number; args: string }

/** `ps -axo pid=,ppid=,%cpu=,args=` parsed. */
export const parsePs = (text: string): Proc[] =>
  text.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), args: m[4] ?? '' }] : []
  })

/** Cores in use by `roots` and everything they started (each process once). */
export const coresOf = (procs: Proc[], roots: number[]): number | null => {
  const live = roots.filter(pid => procs.some(x => x.pid === pid))
  if (live.length === 0) return null
  const kids = new Map<number, Proc[]>()
  for (const x of procs) kids.set(x.ppid, [...(kids.get(x.ppid) ?? []), x])
  const seen = new Set<number>()
  const queue = [...live]
  let cpu = 0
  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    cpu += procs.find(x => x.pid === pid)?.cpu ?? 0
    for (const k of kids.get(pid) ?? []) queue.push(k.pid)
  }
  return cpu / 100
}

const pidsIn = (text: string | undefined) => (text ?? '').split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n > 0)

/**
 * What to say when a render's stage changes to done, failed or stalled; nothing for any other change.
 * `before` is undefined the first time a render is seen, which alerts only for a stall.
 */
export const alertFor = (r: RenderRow, before: RenderRow['stage'] | undefined): string | undefined => {
  if (r.stage === before) return undefined
  if (r.stage === 'done' && before !== undefined) return `${r.title}: render done in ${clock(r.elapsedSec)}`
  if (r.stage === 'failed' && before !== undefined) return `${r.title}: render FAILED after ${clock(r.elapsedSec)}`
  if (r.stage === 'stalled') return `${r.title}: no progress for 15 minutes`
  return undefined
}

// the stage each render had at the last poll; empty until the first poll, which raises nothing
const lastStage = new Map<string, RenderRow['stage']>()
let seeded = false

const poll = async ($: EngineInterface, dir: string, alerts = true) => {
  const entries = await $.fs.list(dir).catch(() => [])
  const nowMs = await $.clock.now()
  const nowSec = nowMs / 1000
  const ps = await $.process.run(['ps', '-axo', 'pid=,ppid=,%cpu=,args=']).catch(() => undefined)
  const procs = ps && ps.exitCode === 0 ? parsePs(ps.stdout) : []
  const found: RenderRow[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.name.startsWith('.') || entry.name.includes('.')) continue
    const reg = parseRegistry(await readText($, `${dir}/${entry.name}`))
    const base: Base = { id: entry.name, title: reg.title || entry.name, channel: reg.channel || '', color: reg.color || undefined }
    let row: RenderRow | undefined
    let pids = pidsIn(reg.pid)
    if (reg.kind === 'command') {
      const c = await runCommand($, entry.name, reg, nowMs).catch(() => undefined)
      row = c?.data ? commandRow(base, c.data, c.samples, nowSec, c.doneAt) : undefined
      pids = [...pids, ...(c?.data?.pids ?? [])]
    } else {
      row = await workDirRow($, base, reg, nowSec).catch(() => undefined)
    }
    if (row) found.push({ ...row, cores: row.stage === 'done' || row.stage === 'failed' ? null : coresOf(procs, pids) })
  }
  found.sort((x, y) => x.id.localeCompare(y.id))
  // a render that changed to done, failed or stalled since the last poll raises a toast and a
  // native notification, once; the first poll after a (re)load only records where things stand
  if (alerts && seeded) {
    for (const r of found) {
      const text = alertFor(r, lastStage.get(r.id))
      if (text) {
        $.ui.toast(text, { timeoutMs: 10000 })
        await $.ui.notify(text, { title: 'Render', key: `render-${r.id}-${r.stage}` }).catch(() => undefined)
      }
    }
  }
  lastStage.clear()
  for (const r of found) lastStage.set(r.id, r.stage)
  seeded = true
  await update($, rows, () => found)
}

const STAGE_TEXT: Record<RenderRow['stage'], string> = {
  bundling: 'bundling',
  uploading: 'uploading',
  rendering: 'rendering',
  joining: 'joining',
  done: 'done',
  failed: 'FAILED',
  stalled: 'stalled',
}

/** `1:05:09`, `05:09`: pacman's clock. */
export const clock = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** The wall-clock time `sec` from now, `21:45`, in the computer's time zone (`offsetMin` east of UTC). */
export const finishAt = (nowMs: number, sec: number, offsetMin: number): string => {
  const d = new Date(nowMs + sec * 1000 + offsetMin * 60000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** `7.4k`, or the exact number under 1,000. */
export const short = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)

export const cells = (r: RenderRow, nowMs: number, offsetMin: number, cpus = 0) => {
  const isDone = r.stage === 'done'
  const fraction = isDone ? 1 : r.fraction ?? null
  const time = clock(r.elapsedSec ?? 0)
  // the finish time alone while running (`ETA:21:25`); once over, the time it took
  const when = isDone ? (r.elapsedSec > 0 ? `done ${time}` : 'done')
    : r.stage === 'failed' ? `FAILED ${time}`
    : r.stage === 'stalled' ? 'stalled'
    : `ETA:${typeof r.leftSec === 'number' ? finishAt(nowMs, r.leftSec, offsetMin) : '--:--'}`
  return {
    channel: r.channel ?? '',
    color: r.color,
    title: cut(r.title ?? r.id, 26),
    when,
    frames: r.framesTotal > 0 && fraction !== null
      ? `${short(isDone ? r.framesTotal : r.framesDone)}/${short(r.framesTotal)}`
      : '',
    // `2/10c`: cores in use out of the computer's total (the total left off until it is known)
    cores: typeof r.cores === 'number' ? `${Math.round(r.cores)}${cpus > 0 ? `/${cpus}` : ''}c` : '',
    fraction: r.stage === 'failed' ? null : fraction,
    stage: STAGE_TEXT[r.stage] ?? r.stage,
    percent: fraction !== null ? `${Math.floor(fraction * 100)}%` : '',
  }
}

/** One coloured piece of a row; `color` is a theme key, so it follows light and dark themes. */
export type Piece = { text: string; color?: string; bold?: boolean }

/** A channel's colour: the same name always gets the same theme colour. */
const PALETTE = ['success', 'suggestion', 'claude', 'merged', 'warning', 'autoAccept', 'planMode']
export const channelColor = (channel: string): string => {
  if (!channel) return 'text'
  let h = 0
  for (const ch of channel) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length] ?? 'text'
}

/**
 * The bar with the percent written in its middle, `[###54%----]`, as coloured pieces: the filled cells,
 * the empty ones and the percent each their own colour. Without a fraction, the stage is written there.
 */
export const barPieces = (fraction: number | null, width: number, label: string, fill: string): Piece[] => {
  const w = Math.max(label.length + 2, width)
  const filled = fraction === null ? 0 : Math.round(Math.min(1, Math.max(0, fraction)) * w)
  const at = Math.floor((w - label.length) / 2)
  const kinds = Array.from({ length: w }, (_, i) =>
    i >= at && i < at + label.length ? 'label' : i < filled ? 'fill' : 'empty')
  const out: Piece[] = [{ text: '[', color: 'subtle' }]
  for (let i = 0; i < w; ) {
    let j = i
    while (j < w && kinds[j] === kinds[i]) j += 1
    const kind = kinds[i]
    out.push(kind === 'label'
      ? { text: label.slice(i - at, j - at), bold: true }
      : { text: (kind === 'fill' ? '#' : '-').repeat(j - i), color: kind === 'fill' ? fill : fraction === null ? 'subtle' : 'inactive' })
    i = j
  }
  out.push({ text: ']', color: 'subtle' })
  return out
}

/** Every row in shared columns, pacman-style, as cells of coloured pieces; the bar fills what is left. */
export const table = (shown: RenderRow[], columns: number, nowMs: number, offsetMin: number, cpus = 0): Piece[][][] => {
  const all = shown.map(r => ({ r, c: cells(r, nowMs, offsetMin, cpus) }))
  const w = {
    title: Math.max(...all.map(x => x.c.title.length)),
    when: Math.max(...all.map(x => x.c.when.length)),
    cores: Math.max(...all.map(x => x.c.cores.length)),
    frames: Math.max(...all.map(x => x.c.frames.length)),
  }
  const opt = (n: number) => (n > 0 ? n + 1 : 0)
  const fixed = w.title + 1 + 2 + 1 + w.when + opt(w.frames) + opt(w.cores)
  // the band's column count runs wide on desktop, hence the margin
  const width = Math.min(24, Math.max(12, columns - fixed - 12))
  return all.map(({ r, c }) => {
    const isBad = r.stage === 'failed' || r.stage === 'stalled'
    const fill = r.stage === 'done' ? 'success' : isBad ? 'error' : 'claude'
    // most to least important, each column its own cell: a band too narrow for them all wraps the
    // last cells onto a second line instead of cutting them off. The channel shows as the title's colour
    return [
      [{ text: c.title.padEnd(w.title), color: c.color || channelColor(c.channel), bold: true }],
      barPieces(c.fraction, width, c.fraction === null ? c.stage : c.percent, fill),
      [{ text: c.when.padEnd(w.when), color: r.stage === 'done' ? 'success' : isBad ? 'error' : 'suggestion', bold: isBad }],
      ...(w.frames > 0 ? [[{ text: c.frames.padStart(w.frames), color: 'subtle' }]] : []),
      ...(w.cores > 0 ? [[{ text: c.cores.padStart(w.cores), color: 'warning' }]] : []),
    ]
  })
}

export const register: Register = (on, options) => {
  let offsetMin = 0
  let cpus = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({ name: 'renders', description: 'Show the render bar again (brings back rows closed with ✕) and list the renders' })
      .catch(() => undefined)
    const run = (argv: string[]) => $.process.run(argv).then(r => r.stdout.trim()).catch(() => '')
    // the module has no time zone or home folder of its own: ask the computer once
    const m = /^([+-])(\d\d)(\d\d)/.exec(await run(['date', '+%z']))
    if (m) offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
    cpus = Number(await run(['getconf', '_NPROCESSORS_ONLN'])) || 0
    const configured = typeof options.registryDir === 'string' ? options.registryDir.trim() : ''
    const home = await run(['printenv', 'HOME'])
    const dir = (configured || '~/.render-progress').replace(/^~(?=\/|$)/, home)
    const alerts = options.alerts !== false
    await poll($, dir, alerts)
    $.clock.every(POLL_MS, () => poll($, dir, alerts))
    return result
  })

  on('command.run', { command: 'renders' }, async $ => {
    await update($, hidden, () => [])
    const list = await read($, rows)
    if (list.length === 0) return { text: 'No renders to show. The bar appears by itself when a render starts.', isTextDisplayOnly: true as const }
    const lines = list.map(r => `${r.title}: ${r.stage === 'done' ? 'done' : r.stage === 'failed' ? 'FAILED' : r.fraction !== null ? `${Math.floor(r.fraction * 100)}%` : r.stage}`)
    return { text: `Render bar shown again.\n${lines.join('\n')}`, isTextDisplayOnly: true as const }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const hide = await read($, hidden)
    const shown = (await read($, rows)).filter(r => !hide.includes(r.id))
    if (shown.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    // room for each row's ✕ at its end
    const lines = table(shown, e.props.bodyColumns - 4, await $.clock.now(), offsetMin, cpus)
    return (
      <Box flexDirection="column">
        {shown.map((r, i) => (
          <Box key={r.id} flexDirection="row" flexWrap="wrap" columnGap={1}>
            {(lines[i] ?? []).map(cell => (
              <Box flexDirection="row">
                {cell.map(piece => (
                  <Text mono color={piece.color} bold={piece.bold}>{piece.text}</Text>
                ))}
              </Box>
            ))}
            {/* ✕ closes this row; /renders brings closed rows back */}
            <Button key={`close-${r.id}`} label="✕" onPress={() => update($, hidden, h => [...h, r.id])} />
          </Box>
        ))}
      </Box>
    )
  })
}
