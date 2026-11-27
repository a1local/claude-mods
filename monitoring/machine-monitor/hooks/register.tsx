import type { EngineInterface, Register } from 'claude-code'

// How often the status line is refreshed, and how often the (slow) temp folder sizes are measured.
const STATUS_MS = 5000
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
export const parseDf = (text: string | undefined): number | undefined => {
  const lines = (text ?? '').trim().split('\n')
  const cols = (lines[lines.length - 1] ?? '').trim().split(/\s+/)
  const kb = lines.length > 1 ? Number(cols[3]) : NaN
  return Number.isFinite(kb) ? kb / 1048576 : undefined
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
  const parts: string[] = []
  if (r.load !== undefined) parts.push(`load ${fmt(r.load)}${r.cpus ? `/${r.cpus}` : ''}`)
  if (r.gpu !== undefined) parts.push(`GPU ${r.gpu}%`)
  if (r.swap) parts.push(`swap ${r.swap.usedGb.toFixed(1)}/${r.swap.totalGb.toFixed(1)}G`)
  if (r.freeGb !== undefined) parts.push(`disk ${Math.floor(r.freeGb)}G free`)
  if (r.tempGb !== undefined) parts.push(`temp ${Math.round(r.tempGb)}G`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

// --- the load guard --------------------------------------------------------------------------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a Bash command runs one of the heavy jobs: each pattern as words, any case. */
export const isHeavy = (command: string, patterns: readonly string[]): boolean =>
  patterns.some(p => new RegExp(`(^|[^A-Za-z0-9_])${escape(p.trim())}(?![A-Za-z0-9_])`, 'i').test(command))

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
  isPolling: boolean
  /** Warnings raised and not yet cleared: `temp`, `free:<path>`. */
  raised: Set<string>
}

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
        `Temp folders hold ${Math.round(s.tempGb)} GB (warning at ${s.tempGbWarn} GB). Clear old render bundles.`)
    }
  } finally {
    s.isMeasuringTemp = false
  }
}

const poll = async ($: EngineInterface, s: State) => {
  if (s.isPolling) return
  s.isPolling = true
  try {
    const [loadText, swapText, gpuText] = await Promise.all([
      run($, ['sysctl', '-n', 'vm.loadavg']),
      run($, ['sysctl', '-n', 'vm.swapusage']),
      run($, ['ioreg', '-r', '-d', '1', '-c', 'IOAccelerator']),
    ])
    let freeGb: number | undefined
    for (const path of s.config.watchPaths) {
      const free = parseDf(await run($, ['df', '-k', path]))
      if (free === undefined) continue
      freeGb = freeGb === undefined ? free : Math.min(freeGb, free)
      await warn($, s, `free:${path}`, free, s.freeGbWarn, true,
        `Only ${Math.floor(free)} GB free on ${path} (warning under ${s.freeGbWarn} GB).`)
    }
    $.ui.status(statusText({
      load: parseLoad(loadText),
      cpus: s.cpus,
      gpu: parseGpu(gpuText),
      swap: parseSwap(swapText),
      freeGb,
      tempGb: s.tempGb !== undefined && s.tempGb > s.tempGbWarn ? s.tempGb : undefined,
    }))
    // du is slow: it runs in the background, and the line shows its result from the next refresh
    const now = await $.clock.now()
    void refreshTemp($, s, now).catch(() => undefined)
  } catch {
    // a status line that cannot be drawn is left as it was
  } finally {
    s.isPolling = false
  }
}

const start = async ($: EngineInterface, s: State) => {
  s.home = (await run($, ['printenv', 'HOME']))?.trim() ?? ''
  s.cpus = Number((await run($, ['getconf', '_NPROCESSORS_ONLN']))?.trim()) || undefined
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
    isPolling: false,
    raised: new Set(),
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // never stand in the way of the session
    await start($, s).catch(() => undefined)
    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await judge($, s, e.command)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) =>
    // fail open: a guard that broke lets the command run rather than block every render
    next(e),
  )
}
