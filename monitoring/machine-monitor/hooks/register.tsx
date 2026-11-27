import type { EngineInterface, Register } from 'claude-code'

import { align, bar, hhmm, label, num as numPiece, parseOffset, recall, remember, replyBox, status, title } from './look'
import type { Reply, Row, Tone } from './look'

// How often the status line is refreshed, and how often the (slow) temp folder sizes are measured.
const STATUS_MS = 5000
// `/machine` measures again first when the latest measurements are older than this.
const FRESH_MS = 10000
const TEMP_EVERY_MS = 2 * 60 * 1000
// A warning that was raised clears only once the value is this far back on the safe side,
// so a value sitting on the threshold does not warn again and again.
const MARGIN_GB = 1

export const DEFAULT_PATTERNS = ['remotion render', 'remotion still', 'blender -b', 'ffmpeg']

/** What the JSON config file may hold; every key is optional. */
export type FileConfig = {
  heavyPatterns: string[]
  watchPaths: string[]
  tempGlobs: string[]
}

/** A command's output, or undefined when it failed or could not start. */
const run = async ($: EngineInterface, argv: string[], timeoutMs = 5000): Promise<string | undefined> =>
  $.process.run(argv, { timeoutMs })
    .then(r => (r.exitCode === 0 ? r.stdout : undefined))
    .catch(() => undefined)

const num = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined

/** `~` and `~/x` to the home folder. */
export const expandHome = (path: string, home: string): string => (home ? path.replace(/^~(?=\/|$)/, home) : path)

/** The config file's text, parsed; anything missing or malformed falls back to the defaults. */
export const parseConfig = (text: string, home: string): FileConfig => {
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
  } catch {
    raw = {}
  }
  return {
    heavyPatterns: strings(raw.heavyPatterns) ?? DEFAULT_PATTERNS,
    watchPaths: (strings(raw.watchPaths) ?? ['~']).map(p => expandHome(p, home)),
    tempGlobs: (strings(raw.tempGlobs) ?? []).map(p => expandHome(p, home)),
  }
}

// --- parsing what the macOS commands print ---------------------------------------------------

/** `sysctl -n vm.loadavg`: `{ 6.21 5.10 4.33 }`, the 1-minute figure. */
export const parseLoad = (text: string | undefined): number | undefined => {
  const m = /([\d.]+)/.exec(text ?? '')
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** `sysctl -n vm.swapusage`: `total = 6144.00M  used = 4915.25M  free = ...`, in GB. */
export const parseSwap = (text: string | undefined): { usedGb: number; totalGb: number } | undefined => {
  const gb = (key: string) => {
    const m = new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT])`).exec(text ?? '')
    if (!m) return undefined
    const scale: Record<string, number> = { K: 1 / 1048576, M: 1 / 1024, G: 1, T: 1024 }
    return Number(m[1]) * (scale[m[2] ?? 'M'] ?? 1)
  }
  const totalGb = gb('total')
  const usedGb = gb('used')
  return totalGb !== undefined && usedGb !== undefined ? { usedGb, totalGb } : undefined
}

/** `df -k <path>`: the free space of its last line (the 4th column, in KB), in GB. */
export const parseDf = (text: string | undefined): number | undefined => parseDisk(text)?.freeGb

/** `df -k <path>`: the free space (4th column) and the disk's size (2nd column) of its last line, in GB. */
export const parseDisk = (text: string | undefined): { freeGb: number; totalGb: number } | undefined => {
  const lines = (text ?? '').trim().split('\n')
  const cols = (lines[lines.length - 1] ?? '').trim().split(/\s+/)
  const freeKb = lines.length > 1 ? Number(cols[3]) : NaN
  const totalKb = lines.length > 1 ? Number(cols[1]) : NaN
  if (!Number.isFinite(freeKb)) return undefined
  return { freeGb: freeKb / 1048576, totalGb: Number.isFinite(totalKb) && totalKb > 0 ? totalKb / 1048576 : freeKb / 1048576 }
}

/** `ioreg -r -d 1 -c IOAccelerator`: the busiest GPU's `"Device Utilization %"=N`. */
export const parseGpu = (text: string | undefined): number | undefined => {
  const all = [...(text ?? '').matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map(m => Number(m[1]))
  return all.length > 0 ? Math.max(...all) : undefined
}

/** `du -sk a b c`: the first column of every line, added up, in GB. */
export const parseDu = (text: string): number =>
  text.split('\n').reduce((sum, line) => sum + (Number(/^\s*(\d+)/.exec(line)?.[1]) || 0), 0) / 1048576

// --- the status line ---------------------------------------------------------------------------

export type Reading = {
  load?: number
  cpus?: number
  gpu?: number
  swap?: { usedGb: number; totalGb: number }
  /** The least free space among the watched paths. */
  freeGb?: number
  /** Total size of the temp folders, shown only once it is over the warning. */
  tempGb?: number
}

const fmt = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1))

/** `load 6.2/10 · GPU 100% · swap 4.8/6.0G · disk 41G free`; a part that could not be read is left out. */
export const statusText = (r: Reading): string | undefined => {
  const parts: [string, string][] = []
  if (r.load !== undefined) parts.push(['load', `${fmt(r.load)}${r.cpus ? `/${r.cpus}` : ''}`])
  if (r.gpu !== undefined) parts.push(['GPU', `${r.gpu}%`])
  if (r.swap) parts.push(['swap', `${r.swap.usedGb.toFixed(1)}/${r.swap.totalGb.toFixed(1)}G`])
  if (r.freeGb !== undefined) parts.push(['disk', `${Math.floor(r.freeGb)}G free`])
  if (r.tempGb !== undefined) parts.push(['temp', `${Math.round(r.tempGb)}G`])
  return parts.length > 0 ? status(parts) : undefined
}

// --- the /machine reply ------------------------------------------------------------------------

/** One watched path's disk. `path` is as the config names it (`~` kept), for showing. */
export type Disk = { path: string; freeGb: number; totalGb: number }

/** Everything `/machine` shows: the latest measurements, the limits, and when they were taken. */
export type Snapshot = {
  load?: number
  cpus?: number
  gpu?: number
  swap?: { usedGb: number; totalGb: number }
  disks: Disk[]
  tempGb?: number
  loadLimit: number
  freeGbWarn: number
  tempGbWarn: number
  at?: number
  offsetMin: number
}

/** A value's share of its limit to a tone: good under 70%, warn from there, bad over the limit. */
export const toneOf = (share: number): Tone => (share > 1 ? 'bad' : share >= 0.7 ? 'warn' : 'good')

const pctText = (fraction: number) => `${Math.round(fraction * 100)}%`
const gb = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1))

/**
 * The `/machine` reply: one row per measure, each a name, a bar, the percent (right-aligned) and
 * what it is out of; coloured by how close the value is to its limit.
 */
export const machineReply = (m: Snapshot): Reply => {
  type Measure = { name: string; fraction: number; tone: Tone; detail: string }
  const measures: Measure[] = []
  if (m.load !== undefined) {
    // the bar is the load against the cores; its colour is the load against the limit the guard holds to
    const of = m.cpus ?? m.loadLimit
    measures.push({
      name: 'load',
      fraction: m.load / of,
      tone: toneOf(m.load / m.loadLimit),
      detail: `${fmt(m.load)} of ${of} ${m.cpus ? 'cores' : 'limit'}`,
    })
  }
  if (m.gpu !== undefined) measures.push({ name: 'GPU', fraction: m.gpu / 100, tone: toneOf(m.gpu / 100), detail: '' })
  if (m.swap) {
    const f = m.swap.totalGb > 0 ? m.swap.usedGb / m.swap.totalGb : 0
    measures.push({ name: 'swap', fraction: f, tone: toneOf(f), detail: `${m.swap.usedGb.toFixed(1)} of ${m.swap.totalGb.toFixed(1)} GB` })
  }
  for (const d of m.disks) {
    // the bar is the share in use; the colour is the free space against the low-disk warning
    const used = d.totalGb > 0 ? (d.totalGb - d.freeGb) / d.totalGb : 0
    measures.push({
      name: `disk ${d.path}`,
      fraction: used,
      tone: toneOf(d.freeGb > 0 ? m.freeGbWarn / d.freeGb : Infinity),
      detail: `${Math.floor(d.freeGb)} GB free of ${Math.round(d.totalGb)} GB`,
    })
  }
  if (m.tempGb !== undefined) {
    const f = m.tempGb / m.tempGbWarn
    measures.push({ name: 'temp', fraction: f, tone: toneOf(f), detail: `${gb(m.tempGb)} of ${m.tempGbWarn} GB` })
  }
  const wPct = Math.max(0, ...measures.map(x => pctText(x.fraction).length))
  const rows: Row[] = measures.map(x => [
    [title(x.name)],
    bar(x.fraction, 10, x.tone),
    [numPiece(pctText(x.fraction).padStart(wPct), x.tone)],
    ...(x.detail ? [[label(x.detail)]] : []),
  ])
  const foot = [
    `limit ${m.loadLimit}`,
    'heavy jobs held back above it',
    m.at === undefined ? 'not measured yet' : `updated ${hhmm(m.at, m.offsetMin)}`,
  ].join(' · ')
  return { title: 'Machine', rows: align(rows), foot, empty: 'Nothing could be measured.' }
}

// --- the load guard --------------------------------------------------------------------------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The parts of a shell command that run: here-document bodies and single-quoted text are dropped,
 * since they are data (a script being written, a `python -c '...'` program), not the command itself.
 */
export const runnable = (command: string): string =>
  command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ')
    .replace(/'[^']*'/g, "''")

/** Words that run the command after them: `nohup x`, `npx x`, `time x`, `bash script.sh`. */
const WRAPPERS = new Set(['nohup', 'time', 'exec', 'sudo', 'env', 'command', 'caffeinate', 'npx', 'bunx', 'node', 'bash', 'sh', 'zsh'])

/**
 * The programs a shell command runs, each with its arguments: the command split at `&&`, `||`, `;`,
 * `|`, `&`, newlines and brackets, then each part's leading `VAR=x`, wrappers (`nohup`, `npx`,
 * `npm exec`, `nice -n 5`, `bash script.sh`) and the program's folder dropped, so
 * `cd kit && nohup /opt/bin/ffmpeg -i x` gives `ffmpeg -i x`.
 */
export const programs = (command: string): string[] =>
  runnable(command)
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .split(/&&|\|\||[;|&\n()`]|\$\(/)
    .map(part => {
      let words = part.trim().split(/\s+/).filter(Boolean)
      for (;;) {
        const w = (words[0] ?? '').replace(/^.*\//, '')
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words = words.slice(1)
        else if ((w === 'npm' || w === 'pnpm') && words[1] === 'exec') words = words.slice(2)
        else if (w === 'nice') words = words.slice(words[1] === '-n' ? 3 : 1)
        else if (WRAPPERS.has(w) && words[1] !== '-c') words = words.slice(1)
        else break
      }
      if (words.length === 0) return ''
      return [(words[0] ?? '').replace(/^.*\//, ''), ...words.slice(1)].join(' ')
    })
    .filter(Boolean)

/**
 * Whether a Bash command runs one of the heavy jobs: a program the command runs starts with the
 * pattern's words (any case). A word that only appears as an argument (`grep ffmpeg`, a path to a
 * render script being read) does not count.
 */
export const isHeavy = (command: string, patterns: readonly string[]): boolean => {
  const progs = programs(command)
  return patterns.some(p => {
    const re = new RegExp(`^${escape(p.trim())}(?![A-Za-z0-9_])`, 'i')
    return progs.some(prog => re.test(prog))
  })
}

export const denyText = (load: number, limit: number) =>
  `Machine load is ${Math.round(load)} (limit ${limit}). Wait a few minutes and retry; check with uptime.`

// --- temp folders ----------------------------------------------------------------------------

const globToRegex = (glob: string) =>
  new RegExp(`^${glob.split('').map(c => (c === '*' ? '.*' : c === '?' ? '.' : escape(c))).join('')}$`)

/** The paths a list of globs names: a wildcard only in the last part (`/tmp/bundle-*`), or a plain path. */
const expandGlobs = async ($: EngineInterface, globs: readonly string[]): Promise<string[]> => {
  const out: string[] = []
  for (const glob of globs) {
    const slash = glob.lastIndexOf('/')
    const dir = slash > 0 ? glob.slice(0, slash) : '/'
    const base = glob.slice(slash + 1)
    if (/[*?]/.test(base)) {
      const re = globToRegex(base)
      const entries = await $.fs.list(dir).catch(() => [])
      for (const e of entries) if (re.test(e.name)) out.push(`${dir}/${e.name}`)
    } else if (await $.fs.exists(glob).catch(() => false)) {
      out.push(glob)
    }
  }
  return [...new Set(out)]
}

const measureTemp = async ($: EngineInterface, globs: readonly string[]): Promise<number | undefined> => {
  if (globs.length === 0) return undefined
  const paths = await expandGlobs($, globs)
  let gb = 0
  for (let i = 0; i < paths.length; i += 200) {
    // du exits non-zero when a folder vanishes while it counts; what it printed still holds
    const res = await $.process.run(['du', '-sk', ...paths.slice(i, i + 200)], { timeoutMs: 90000 }).catch(() => undefined)
    if (res) gb += parseDu(res.stdout)
  }
  return gb
}

// --- warnings, once per crossing ---------------------------------------------------------------

export type Crossing = 'raise' | 'clear' | undefined

/** Whether a value has just gone past its threshold (`raise`) or come back with some margin (`clear`). */
export const crossing = (isRaised: boolean, value: number, threshold: number, isBadWhenBelow: boolean): Crossing => {
  const isBad = isBadWhenBelow ? value < threshold : value > threshold
  const isClear = isBadWhenBelow ? value >= threshold + MARGIN_GB : value <= threshold - MARGIN_GB
  if (!isRaised && isBad) return 'raise'
  if (isRaised && isClear) return 'clear'
  return undefined
}

/** What one session's copy of the mod knows. */
type State = {
  loadLimit: number
  freeGbWarn: number
  tempGbWarn: number
  configPath: string
  home: string
  config: FileConfig
  cpus?: number
  tempGb?: number
  tempMeasuredAt: number
  isMeasuringTemp: boolean
  /** The poll running now, which `/machine` waits on. */
  polling?: Promise<void>
  /** The latest measurements, for `/machine`. */
  last?: { load?: number; gpu?: number; swap?: { usedGb: number; totalGb: number }; disks: Disk[]; at: number }
  /** The computer's time zone, minutes east of UTC (from `date +%z`). */
  offsetMin: number
  /** Warnings raised and not yet cleared: `temp`, `free:<path>`. */
  raised: Set<string>
}

/** `Disk: only 10 GB free on /`. */
export const diskAlert = (freeGb: number, path: string) => `Disk: only ${Math.floor(freeGb)} GB free on ${path}`
/** `Temp folders: 30 GB (limit 20 GB)`. */
export const tempAlert = (tempGb: number, limitGb: number) => `Temp folders: ${Math.round(tempGb)} GB (limit ${limitGb} GB)`

/** The home folder back to `~`, for showing a path. */
export const unexpandHome = (path: string, home: string): string =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

const loadConfig = async ($: EngineInterface, s: State) => {
  const text = await $.fs.read(expandHome(s.configPath, s.home)).then(t => (typeof t === 'string' ? t : '{}')).catch(() => '{}')
  s.config = parseConfig(text, s.home)
}

const warn = async ($: EngineInterface, s: State, key: string, value: number, threshold: number, isBadWhenBelow: boolean, text: string) => {
  const c = crossing(s.raised.has(key), value, threshold, isBadWhenBelow)
  if (c === 'clear') s.raised.delete(key)
  if (c !== 'raise') return
  s.raised.add(key)
  $.ui.toast(text, { timeoutMs: 10000 })
  await $.ui.notify(text, { title: 'Machine monitor' }).catch(() => undefined)
}

const refreshTemp = async ($: EngineInterface, s: State, now: number) => {
  if (s.isMeasuringTemp || now - s.tempMeasuredAt < TEMP_EVERY_MS) return
  s.isMeasuringTemp = true
  s.tempMeasuredAt = now
  try {
    await loadConfig($, s)
    s.tempGb = await measureTemp($, s.config.tempGlobs)
    if (s.tempGb !== undefined) {
      await warn($, s, 'temp', s.tempGb, s.tempGbWarn, false,
        tempAlert(s.tempGb, s.tempGbWarn))
    }
  } finally {
    s.isMeasuringTemp = false
  }
}

/** One poll at a time: a second caller waits on the one running. */
const poll = ($: EngineInterface, s: State): Promise<void> => {
  if (!s.polling) s.polling = measure($, s).finally(() => { s.polling = undefined })
  return s.polling
}

const measure = async ($: EngineInterface, s: State) => {
  try {
    const [loadText, swapText, gpuText] = await Promise.all([
      run($, ['sysctl', '-n', 'vm.loadavg']),
      run($, ['sysctl', '-n', 'vm.swapusage']),
      run($, ['ioreg', '-r', '-d', '1', '-c', 'IOAccelerator']),
    ])
    let freeGb: number | undefined
    const disks: Disk[] = []
    for (const path of s.config.watchPaths) {
      const disk = parseDisk(await run($, ['df', '-k', path]))
      if (disk === undefined) continue
      const free = disk.freeGb
      const shown = unexpandHome(path, s.home)
      disks.push({ path: shown, ...disk })
      freeGb = freeGb === undefined ? free : Math.min(freeGb, free)
      await warn($, s, `free:${path}`, free, s.freeGbWarn, true, diskAlert(free, shown))
    }
    const now = await $.clock.now()
    s.last = { load: parseLoad(loadText), gpu: parseGpu(gpuText), swap: parseSwap(swapText), disks, at: now }
    $.ui.status(statusText({
      load: s.last.load,
      cpus: s.cpus,
      gpu: s.last.gpu,
      swap: s.last.swap,
      freeGb,
      tempGb: s.tempGb !== undefined && s.tempGb > s.tempGbWarn ? s.tempGb : undefined,
    }))
    // du is slow: it runs in the background, and the line shows its result from the next refresh
    void refreshTemp($, s, now).catch(() => undefined)
  } catch {
    // a status line that cannot be drawn is left as it was
  }
}

/** `/machine`: measures again if the latest measurements are over 10 s old, then answers the reply. */
const showMachine = async ($: EngineInterface, s: State) => {
  const now = await $.clock.now()
  if (!s.last || now - s.last.at > FRESH_MS) await poll($, s).catch(() => undefined)
  const last = s.last
  return {
    text: remember(machineReply({
      load: last?.load,
      cpus: s.cpus,
      gpu: last?.gpu,
      swap: last?.swap,
      disks: last?.disks ?? [],
      tempGb: s.tempGb,
      loadLimit: s.loadLimit,
      freeGbWarn: s.freeGbWarn,
      tempGbWarn: s.tempGbWarn,
      at: last?.at,
      offsetMin: s.offsetMin,
    })),
  }
}

const start = async ($: EngineInterface, s: State) => {
  await $.command.register({ name: 'machine', description: 'Machine load, GPU, swap, free disk and temp folders against their limits' })
    .catch(() => undefined)
  s.home = (await run($, ['printenv', 'HOME']))?.trim() ?? ''
  s.cpus = Number((await run($, ['getconf', '_NPROCESSORS_ONLN']))?.trim()) || undefined
  s.offsetMin = parseOffset((await run($, ['date', '+%z'])) ?? '')
  await loadConfig($, s)
  await poll($, s)
  $.clock.every(STATUS_MS, () => { void poll($, s) })
}

/** The guard's verdict on a Bash command: a refusal, or undefined to let it run. */
const judge = async ($: EngineInterface, s: State, command: string): Promise<string | undefined> => {
  if (!isHeavy(command, s.config.heavyPatterns)) return undefined
  const load = parseLoad(await run($, ['sysctl', '-n', 'vm.loadavg'], 3000))
  return load !== undefined && load > s.loadLimit ? denyText(load, s.loadLimit) : undefined
}

export const register: Register = (on, options) => {
  const s: State = {
    loadLimit: num(options.loadLimit, 20),
    freeGbWarn: num(options.freeGbWarn, 20),
    tempGbWarn: num(options.tempGbWarn, 20),
    configPath: typeof options.configFile === 'string' && options.configFile.trim() !== ''
      ? options.configFile.trim()
      : '~/.claude-mods/machine-monitor.json',
    home: '',
    config: parseConfig('{}', ''),
    tempMeasuredAt: 0,
    isMeasuringTemp: false,
    offsetMin: 0,
    raised: new Set(),
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // never stand in the way of the session
    await start($, s).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'machine' }, $ => showMachine($, s))

  // the reply in the chat, drawn in the set's look (see STYLE/STYLE.md)
  on('ui.render', { component: 'CommandOutput', props: { command: 'machine' } }, async ($, e, next) => {
    const reply = e.props.isErrored ? undefined : recall(e.props.text)
    return reply ? replyBox($.ui.resolve(e), reply) : next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await judge($, s, e.command)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) =>
    // fail open: a guard that broke lets the command run rather than block every render
    next(e),
  )
}
