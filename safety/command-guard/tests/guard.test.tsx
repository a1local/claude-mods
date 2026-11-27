import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { firstMatch, parseRules, runnable } from '../hooks/register'

const HOME = '/home/demo'
const FILE = `${HOME}/.claude-mods/command-guard.json`

const RULES = JSON.stringify({
  rules: [
    {
      name: 'no-pkill',
      pattern: '(^|[;&|(])\\s*(pkill|killall)\\b',
      reason: 'Other sessions run jobs here. Stop your own process by PID instead.',
    },
    {
      name: 'no-force-push',
      pattern: '\\bgit\\s+push\\b.*\\s(-f|--force)\\b',
      reason: 'Never force-push. Push a new commit instead.',
    },
    {
      name: 'no-env-writes',
      tool: 'Write',
      pattern: '(^|/)\\.env$',
      reason: 'Secrets stay out of files Claude writes.',
    },
  ],
})

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** Stands for the engine: a rules file with the given text, HOME, and a tool that just runs. */
const engine = (
  on: On,
  file: { text: string; mtimeMs: number } | undefined,
  toasts: string[],
  calls: string[] = [],
  { path = FILE, hasShell = true }: { path?: string; hasShell?: boolean } = {},
) => {
  on('process.run', (_, e) => {
    if (!hasShell) throw new Error('no shell')
    return e.argv[0] === 'printenv' ? ran(`${HOME}\n`) : ran('')
  })
  on('fs.stat', (_, e) => {
    if (!file || e.path !== path) throw new Error('ENOENT')
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (!file || e.path !== path) throw new Error('ENOENT')
    return { value: file.text }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'guard' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    calls.push(e.tool === 'Bash' ? e.command : e.tool)
    return { result: {} }
  })
}

test('a matching command is refused with the rule\'s reason, and a toast names the rule', async ($, on) => {
  const toasts: string[] = []
  const calls: string[] = []
  engine(on, { text: RULES, mtimeMs: 1 }, toasts, calls)

  const r = await $.tool.call({ tool: 'Bash', command: 'pkill -f remotion' })
  expect(r.deny).toContain('Other sessions run jobs here. Stop your own process by PID instead.')
  expect(r.deny).toContain('no-pkill')
  expect(calls).toEqual([])
  expect(toasts).toEqual(['command-guard refused a Bash call: no-pkill'])
})

test('a command no rule matches runs', async ($, on) => {
  const toasts: string[] = []
  const calls: string[] = []
  engine(on, { text: RULES, mtimeMs: 1 }, toasts, calls)

  const r = await $.tool.call({ tool: 'Bash', command: 'ps aux | grep remotion' })
  expect(r.deny).toBe(undefined)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(calls).toEqual(['ps aux | grep remotion', 'git push origin main'])
  expect(toasts).toEqual([])
})

test('a Write rule checks the file path; Bash rules leave Write alone', async ($, on) => {
  const toasts: string[] = []
  engine(on, { text: RULES, mtimeMs: 1 }, toasts)

  const denied = await $.tool.call({ tool: 'Write', file_path: '/app/.env', content: 'KEY=1' })
  expect(denied.deny).toContain('Secrets stay out')
  const ok = await $.tool.call({ tool: 'Write', file_path: '/app/notes.md', content: 'never pkill anything' })
  expect(ok.deny).toBe(undefined)
})

test('a broken rules file lets commands through and is reported once', async ($, on) => {
  const toasts: string[] = []
  const calls: string[] = []
  engine(on, { text: '{ "rules": [ { "pattern": ', mtimeMs: 1 }, toasts, calls)

  await $.tool.call({ tool: 'Bash', command: 'pkill -f remotion' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(calls).toEqual(['pkill -f remotion', 'ls'])
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('not valid JSON')
})

test('no rules file: everything runs, nothing is reported', async ($, on) => {
  const toasts: string[] = []
  const calls: string[] = []
  engine(on, undefined, toasts, calls)

  await $.tool.call({ tool: 'Bash', command: 'pkill -f remotion' })
  expect(calls).toEqual(['pkill -f remotion'])
  expect(toasts).toEqual([])
})

test('when the home folder cannot be found, calls go through and it says so once', async ($, on) => {
  const toasts: string[] = []
  const calls: string[] = []
  engine(on, { text: RULES, mtimeMs: 1 }, toasts, calls, { hasShell: false })

  await $.tool.call({ tool: 'Bash', command: 'pkill -f remotion' })
  await $.tool.call({ tool: 'Bash', command: 'killall node' })
  expect(calls).toEqual(['pkill -f remotion', 'killall node'])
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('calls are let through')
})

test('the file is read again when it changes', async ($, on) => {
  const toasts: string[] = []
  const calls: string[] = []
  const file = { text: JSON.stringify({ rules: [] }), mtimeMs: 1 }
  engine(on, file, toasts, calls)

  await $.tool.call({ tool: 'Bash', command: 'killall node' })
  expect(calls).toEqual(['killall node'])

  file.text = RULES
  file.mtimeMs = 2
  const r = await $.tool.call({ tool: 'Bash', command: 'killall node' })
  expect(r.deny).toContain('no-pkill')
})

test('a custom rules file from the config', { options: { rulesFile: '/etc/guard.json' } }, async ($, on) => {
  const calls: string[] = []
  engine(on, { text: RULES, mtimeMs: 1 }, [], calls, { path: '/etc/guard.json' })

  const r = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
  expect(r.deny).toContain('Never force-push')
})

test('/guard lists the rules and how often each fired', async ($, on) => {
  engine(on, { text: RULES, mtimeMs: 1 }, [])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pkill node' })
  await $.tool.call({ tool: 'Bash', command: 'ls && killall node' })
  const out = await $.command.run({
    command: 'guard',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(out.text).toContain('3 active rules from ~/.claude-mods/command-guard.json')
  expect(out.text).toContain('no-pkill (Bash): refused 2 times this session')
  expect(out.text).toContain('no-force-push (Bash): refused 0 times this session')
  expect(out.text).toContain('no-env-writes (Write): refused 0 times this session')
})

test('parseRules: bad rules are skipped with a reason, good ones kept; g and y flags dropped', () => {
  const loaded = parseRules(JSON.stringify([
    { name: 'ok', pattern: 'rm\\s+-rf\\s+/', flags: 'gi', reason: 'Not the root folder.' },
    { name: 'bad-regex', pattern: '(', reason: 'x' },
    { name: 'no-reason', pattern: 'x' },
    { name: 'odd-tool', pattern: 'x', reason: 'x', tool: 'Read' },
  ]))
  expect(loaded.rules.map(r => r.name)).toEqual(['ok'])
  expect(loaded.rules[0]?.flags).toBe('i')
  expect(loaded.problems.length).toBe(3)
  // without the g flag the same text matches every time
  const rules = loaded.rules
  expect(firstMatch(rules, 'Bash', ['RM -rf /'])?.name).toBe('ok')
  expect(firstMatch(rules, 'Bash', ['RM -rf /'])?.name).toBe('ok')
  expect(firstMatch(rules, 'Edit', ['rm -rf /'])).toBe(undefined)
  expect(parseRules('{"rules": 3}').problems[0]).toContain('no "rules" list')
})

test('text a command only writes is not checked as a command', () => {
  // a here-document body or single-quoted text is data: a doc that quotes a forbidden command is fine
  expect(runnable("cat > notes.md <<'EOF'\nnever run pkill here\nEOF")).not.toContain('pkill')
  expect(runnable("python3 -c 'print(\"pkill\")'")).not.toContain('pkill')
  // the command itself still is
  expect(runnable('cat <<EOF > a.txt\nx\nEOF\npkill -f x')).toContain('pkill -f x')
  expect(runnable('pkill -f "remotion render"')).toContain('pkill')
})
