import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Rule } from '../types'

// Your rules live in one JSON file outside any repo (default ~/.claude-mods/command-guard.json).
// It is read again whenever its modified time or size changes. See README.md for the format.
const DEFAULT_FILE = '~/.claude-mods/command-guard.json'
const TOOLS = ['Bash', 'Write', 'Edit'] as const
type Tool = (typeof TOOLS)[number]

const fired = atom({ plugin: 'command-guard', key: 'fired' } as const, {})

export type Compiled = Rule & { re: RegExp }
export type Loaded = { rules: Compiled[]; problems: string[]; isMissing?: boolean }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Parse the rules file's text: a list of rules, or `{ "rules": [...] }`. Never throws. */
export const parseRules = (text: string): Loaded => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    return { rules: [], problems: [`the rules file is not valid JSON (${message(err)}), so no rules are checked`] }
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { rules?: unknown }).rules)
      ? ((data as { rules: unknown[] }).rules)
      : undefined
  if (!list) return { rules: [], problems: ['the rules file holds no "rules" list, so no rules are checked'] }

  const rules: Compiled[] = []
  const problems: string[] = []
  list.forEach((raw, i) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `rule ${i + 1}`
    if (typeof r.pattern !== 'string' || r.pattern === '' || typeof r.reason !== 'string' || r.reason.trim() === '') {
      problems.push(`"${name}" skipped: it needs a "pattern" and a "reason"`)
      return
    }
    const tool = r.tool === undefined ? 'Bash' : r.tool
    if (!TOOLS.includes(tool as Tool)) {
      problems.push(`"${name}" skipped: "tool" must be Bash, Write or Edit`)
      return
    }
    // g and y make .test() remember where it stopped, so the same command could pass on the next try
    const flags = typeof r.flags === 'string' ? r.flags.replace(/[gy]/g, '') : ''
    try {
      rules.push({ name, pattern: r.pattern, flags, reason: r.reason.trim(), tool: tool as Tool, re: new RegExp(r.pattern, flags) })
    } catch (err) {
      problems.push(`"${name}" skipped: ${message(err)}`)
    }
  })
  return { rules, problems }
}

/** The first rule for this tool that matches any of the texts. */
export const firstMatch = (rules: readonly Compiled[], tool: Tool, texts: readonly (string | undefined)[]) =>
  rules.find(r => r.tool === tool && texts.some(t => typeof t === 'string' && r.re.test(t)))

// Per load of the module: the settings, the home folder, the last parse, and the problems already shown.
let configured = DEFAULT_FILE
let showToasts = true
let home: string | undefined
let cache: { path: string; stamp: string; loaded: Loaded } | undefined
const reported = new Set<string>()

/** Toast a problem once per module load, so a broken file is mentioned, not repeated on every command. */
const reportOnce = ($: EngineInterface, text: string) => {
  if (reported.has(text)) return
  reported.add(text)
  $.ui.toast(`command-guard: ${text}`, { timeoutMs: 10000 })
}

const rulesPath = async ($: EngineInterface) => {
  if (!/^~(\/|$)/.test(configured)) return configured
  // the module has no environment of its own: ask the computer once
  home ??= (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  if (!home) throw new Error('HOME is not set')
  return configured.replace(/^~/, home)
}

/** The rules, parsed again only when the file's modified time or size changed. */
const load = async ($: EngineInterface): Promise<Loaded> => {
  const path = await rulesPath($)
  const st = await $.fs.stat(path).catch(() => undefined)
  if (!st) return { rules: [], problems: [], isMissing: true }
  const stamp = `${st.mtimeMs}:${st.size}`
  if (cache && cache.path === path && cache.stamp === stamp) return cache.loaded
  const text = await $.fs.read(path)
  const loaded = parseRules(typeof text === 'string' ? text : '')
  cache = { path, stamp, loaded }
  for (const p of loaded.problems) reportOnce($, `${configured}: ${p}`)
  return loaded
}

/** The refusal text when a rule matches; undefined to let the call run. Fails open. */
const judge = async ($: EngineInterface, tool: Tool, texts: readonly (string | undefined)[]) => {
  let hit: Compiled | undefined
  try {
    hit = firstMatch((await load($)).rules, tool, texts)
  } catch (err) {
    reportOnce($, `could not check the rules (${message(err)}), so calls are let through`)
    return undefined
  }
  if (!hit) return undefined
  const name = hit.name
  await update($, fired, m => ({ ...m, [name]: (m[name] ?? 0) + 1 })).catch(() => undefined)
  if (showToasts) $.ui.toast(`command-guard refused a ${tool} call: ${name}`)
  return `Refused by the command-guard rule "${name}": ${hit.reason}`
}

/** A guard that throws or runs out of time lets the call through (fail open) and says so once. */
const failOpen = ($: EngineInterface) => reportOnce($, 'a check failed, so calls are let through')

export const register: Register = (on, options) => {
  configured = typeof options.rulesFile === 'string' && options.rulesFile.trim() ? options.rulesFile.trim() : DEFAULT_FILE
  showToasts = options.toasts !== false
  home = undefined
  cache = undefined
  reported.clear()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await judge($, 'Bash', [e.command])
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => {
    failOpen($)
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await judge($, 'Write', [e.file_path, e.content])
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => {
    failOpen($)
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await judge($, 'Edit', [e.file_path, e.new_string])
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => {
    failOpen($)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'guard', description: 'List the command-guard rules and how often each refused a call this session' })
      .catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'guard' }, async $ => {
    let loaded: Loaded
    try {
      loaded = await load($)
    } catch (err) {
      return { text: `command-guard: could not read ${configured} (${message(err)}). Calls are let through.` }
    }
    if (loaded.isMissing) {
      return { text: `command-guard: no rules file at ${configured}, so nothing is checked. See the mod's README for the format.` }
    }
    const counts = await read($, fired).catch(() => ({}) as Record<string, number>)
    const lines = [`command-guard: ${loaded.rules.length} active rule${loaded.rules.length === 1 ? '' : 's'} from ${configured}`]
    for (const r of loaded.rules) {
      const n = counts[r.name] ?? 0
      lines.push(`  ${r.name} (${r.tool}): refused ${n} time${n === 1 ? '' : 's'} this session`)
      lines.push(`    /${r.pattern}/${r.flags ?? ''}`)
    }
    for (const p of loaded.problems) lines.push(`  problem: ${p}`)
    return { text: lines.join('\n') }
  })
}
