import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RenderRow } from '../types'
import { align, bandLine, bar, clock, cut, hhmm, label, nameColor, parseOffset, recall, remember, replyBox, short, title, toned, turn } from './look'
import type { Piece, Reply, Row, Tone } from './look'

// Each render describes itself in one small file in the registry folder (default ~/.render-progress):
// `key=value` lines. See README.md for the format. The mod reads them every few seconds.
const POLL_MS = 3000
const COMMAND_EVERY_MS = 15000 // a `kind=command` render's command runs at most this often
const STALL_SEC = 15 * 60 // no log written for this long while rendering
const KEEP_DONE_SEC = 2 * 60 * 60 // a finished render stays this long, unless hidden
const IGNORE_OLDER_SEC = 2 * 24 * 60 * 60

const rows = atom({ plugin: 'render-progress', key: 'rows' } as const, [])
const hidden = atom({ plugin: 'render-progress', key: 'hidden' } as const, [])
// which render the band shows when several are running (‹ › flick between them)
const page = atom({ plugin: 'render-progress', key: 'page' } as const, 0)

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

export type Proc = { pid: number; ppid: number; cpu: number; etimeSec: number; args: string }

/** `[[dd-]hh:]mm:ss`, as ps prints elapsed time, in seconds. */
export const parseEtime = (t: string): number => {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t.trim())
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0
}

/** `ps -axo pid=,ppid=,%cpu=,etime=,args=` parsed. */
export const parsePs = (text: string): Proc[] =>
  text.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), etimeSec: parseEtime(m[4] ?? ''), args: m[5] ?? '' }] : []
  })

/** `roots` and every process they started. */
export const treeOf = (procs: Proc[], roots: number[]): Set<number> => {
  const kids = new Map<number, number[]>()
  for (const x of procs) kids.set(x.ppid, [...(kids.get(x.ppid) ?? []), x.pid])
  const seen = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    queue.push(...(kids.get(pid) ?? []))
  }
  return seen
}

const base = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path
/** The project a binary belongs to: the folder above its `node_modules` (or `kit/node_modules`). */
const projectOf = (path: string) => {
  const m = /\/([^/]+)\/(?:kit\/)?node_modules\//.exec(path)
  return m?.[1] ?? ''
}

/**
 * Renders no registry file describes: `remotion render` (the node process itself) and `blender -b`
 * processes outside the process trees of registered renders. Their progress goes to whoever started
 * them, so a row shows what is rendering, for how long, and on how many cores.
 */
export const detectRenders = (procs: Proc[], covered: Set<number>): RenderRow[] => {
  const out: RenderRow[] = []
  for (const x of procs) {
    if (covered.has(x.pid)) continue
    const remotion = /^node\s+(\S*remotion)\s+render\s+(.*)$/.exec(x.args)
    if (remotion) {
      const words = (remotion[2] ?? '').split(/\s+/).filter(w => w && !w.startsWith('-'))
      const [, composition, output] = words
      const project = projectOf(remotion[1] ?? '')
      out.push({
        id: `detected-${x.pid}`, kind: 'detected', channel: project,
        title: [composition, output ? base(output) : ''].filter(Boolean).join(' → ') || 'remotion render',
        stage: 'rendering', fraction: null, framesDone: 0, framesTotal: 0, elapsedSec: x.etimeSec, leftSec: null,
        cores: coresOf(procs, [x.pid]),
      })
      continue
    }
    const blender = /^(\S*\/)?blender\s+(?:.*\s)?-b(?:\s|$)/i.exec(x.args)
    if (blender && /blender$/i.test((x.args.split(/\s+/)[0] ?? ''))) {
      const shot = /\s--\s+(\S+)/.exec(x.args)?.[1]
      const file = /\s(\S+\.blend)(?:\s|$)/.exec(x.args)?.[1]
      out.push({
        id: `detected-${x.pid}`, kind: 'detected', channel: 'blender',
        title: `Blender ${shot ?? (file ? base(file) : '')}`.trim(),
        stage: 'rendering', fraction: null, framesDone: 0, framesTotal: 0, elapsedSec: x.etimeSec, leftSec: null,
        cores: coresOf(procs, [x.pid]),
      })
    }
  }
  return out
}

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

const poll = async ($: EngineInterface, dir: string, alerts = true, detect = true) => {
  const entries = await $.fs.list(dir).catch(() => [])
  const nowMs = await $.clock.now()
  const nowSec = nowMs / 1000
  const ps = await $.process.run(['ps', '-axo', 'pid=,ppid=,%cpu=,etime=,args=']).catch(() => undefined)
  const procs = ps && ps.exitCode === 0 ? parsePs(ps.stdout) : []
  const found: RenderRow[] = []
  const registered: number[] = []
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
    registered.push(...pids)
    if (row) found.push({ ...row, cores: row.stage === 'done' || row.stage === 'failed' ? null : coresOf(procs, pids) })
  }
  found.sort((x, y) => x.id.localeCompare(y.id))
  // and any render running that no registry file describes
  if (detect) found.push(...detectRenders(procs, treeOf(procs, registered)))
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

/**
 * One render as the set's cells, most to least important: title (in its channel's colour), the bar with
 * the percent inside, the finish time, frames, cores. See STYLE/STYLE.md.
 */
export const renderCells = (r: RenderRow, nowMs: number, offsetMin: number, cpus = 0): Row => {
  const isDone = r.stage === 'done'
  const isBad = r.stage === 'failed' || r.stage === 'stalled'
  const fraction = isDone ? 1 : r.stage === 'failed' ? null : r.fraction ?? null
  const name = r.title || r.id
  const tone: Tone = isDone ? 'good' : isBad ? 'bad' : 'work'
  const when = r.kind === 'detected' ? label(`running ${clock(r.elapsedSec)}`)
    : isDone ? toned(r.elapsedSec > 0 ? `done ${clock(r.elapsedSec)}` : 'done', 'good')
    : r.stage === 'failed' ? toned(`FAILED ${clock(r.elapsedSec ?? 0)}`, 'bad', true)
    : r.stage === 'stalled' ? toned('stalled', 'bad', true)
    : toned(`ETA:${typeof r.leftSec === 'number' ? hhmm(nowMs + r.leftSec * 1000, offsetMin) : '--:--'}`, 'info')
  const cells: Row = [
    [title(cut(name, 26), r.color || nameColor(r.channel || name))],
    bar(fraction, 16, tone, fraction === null ? STAGE_TEXT[r.stage] : `${Math.floor(fraction * 100)}%`),
    [when],
  ]
  if (r.framesTotal > 0 && fraction !== null) cells.push([label(`${short(isDone ? r.framesTotal : r.framesDone)}/${short(r.framesTotal)}`)])
  if (typeof r.cores === 'number') cells.push([toned(`${Math.round(r.cores)}${cpus > 0 ? `/${cpus}` : ''}c`, 'warn')])
  return cells
}

/** The renders as lined-up lines. */
export const renderLines = (shown: RenderRow[], nowMs: number, offsetMin: number, cpus = 0): Piece[][] =>
  align(shown.map(r => renderCells(r, nowMs, offsetMin, cpus)))

/** `/renders`: every render, in the set's reply box. */
export const rendersReply = (list: RenderRow[], nowMs: number, offsetMin: number, cpus = 0): Reply => {
  const count = (pred: (r: RenderRow) => boolean) => list.filter(pred).length
  const running = count(r => r.stage !== 'done' && r.stage !== 'failed')
  const parts = [
    running > 0 ? `${running} rendering` : '',
    count(r => r.stage === 'done') > 0 ? `${count(r => r.stage === 'done')} done` : '',
    count(r => r.stage === 'failed') > 0 ? `${count(r => r.stage === 'failed')} failed` : '',
    'closed rows shown again above the prompt',
  ].filter(Boolean)
  return {
    title: 'Renders',
    rows: renderLines(list, nowMs, offsetMin, cpus),
    foot: parts.join(' · '),
    empty: 'Nothing rendering. The bar appears by itself when a render starts.',
  }
}

export const register: Register = (on, options) => {
  let offsetMin = 0
  let cpus = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({ name: 'renders', description: 'List the renders and bring back rows closed with ✕' })
      .catch(() => undefined)
    const run = (argv: string[]) => $.process.run(argv).then(r => r.stdout.trim()).catch(() => '')
    // the module has no time zone or home folder of its own: ask the computer once
    offsetMin = parseOffset(await run(['date', '+%z']))
    cpus = Number(await run(['getconf', '_NPROCESSORS_ONLN'])) || 0
    const configured = typeof options.registryDir === 'string' ? options.registryDir.trim() : ''
    const home = await run(['printenv', 'HOME'])
    const dir = (configured || '~/.render-progress').replace(/^~(?=\/|$)/, home)
    const alerts = options.alerts !== false
    const detect = options.detect !== false
    await poll($, dir, alerts, detect)
    $.clock.every(POLL_MS, () => poll($, dir, alerts, detect))
    return result
  })

  on('command.run', { command: 'renders' }, async $ => {
    await update($, hidden, () => [])
    await update($, page, () => 0)
    const reply = rendersReply(await read($, rows), await $.clock.now(), offsetMin, cpus)
    return { text: remember(reply), isTextDisplayOnly: true as const }
  })

  // the reply in the chat, in the set's look
  on('ui.render', { component: 'CommandOutput', props: { command: 'renders' } }, async ($, e, next) => {
    const reply = e.props.isErrored ? undefined : recall(e.props.text)
    return reply ? replyBox($.ui.resolve(e), reply) : next(e)
  })

  // the band above the prompt: one line, one render at a time; with several, ‹ 2/3 › flicks between
  // them (lined up as a set, so nothing jumps as you flick) and ✕ closes the one in view
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const hide = await read($, hidden)
    const shown = (await read($, rows)).filter(r => !hide.includes(r.id))
    if (shown.length === 0) return next(e)
    const ui = $.ui.resolve(e)
    const lines = renderLines(shown, await $.clock.now(), offsetMin, cpus)
    const at = Math.min(Math.max(0, await read($, page)), shown.length - 1)
    const r = shown[at] as RenderRow
    return bandLine(ui, r.id, lines[at] ?? [], () => { void update($, hidden, h => [...h, r.id]) }, {
      at,
      total: shown.length,
      onPrev: () => { void update($, page, () => turn(at, -1, shown.length)) },
      onNext: () => { void update($, page, () => turn(at, 1, shown.length)) },
    })
  })
}
