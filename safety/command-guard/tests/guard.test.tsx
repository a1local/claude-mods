import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { firstMatch, guardReply, parseRules, runnable } from '../hooks/register'

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
  expect(toasts).toEqual(['Guard: refused Bash (no-pkill)'])
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

/** `/guard` typed at the prompt. */
const RUN = { command: 'guard', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const ROW_PKILL = 'no-pkill       Bash   2×  Other sessions run jobs here. Stop your own process by PID…'
const ROW_PUSH = 'no-force-push  Bash   0×  Never force-push. Push a new commit instead.'
const ROW_ENV = 'no-env-writes  Write  0×  Secrets stay out of files Claude writes.'

test('/guard lists the rules and how often each fired', async ($, on) => {
  engine(on, { text: RULES, mtimeMs: 1 }, [])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pkill node' })
  await $.tool.call({ tool: 'Bash', command: 'ls && killall node' })
  const out = await $.command.run(RUN)
  expect(out.text?.split('\n')).toEqual([
    'Command guard',
    ROW_PKILL,
    ROW_PUSH,
    ROW_ENV,
    '3 rules · 2 refusals this session · rules file ~/.claude-mods/command-guard.json',
  ])
})

test('the /guard reply draws in the chat as rows, refusals in the warn tone', async ($, on) => {
  engine(on, { text: RULES, mtimeMs: 1 }, [])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pkill node' })
  await $.tool.call({ tool: 'Bash', command: 'killall node' })
  const out = await $.command.run(RUN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'command-guard', surface, component: 'CommandOutput',
      props: { command: 'guard', args: '', text: out.text ?? '', isErrored: false },
    })
    expect((await ui.find({ type: 'Text', text: 'Command guard' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Box', key: 'row-0' }))?.text).toBe(ROW_PKILL)
    expect((await ui.find({ type: 'Box', key: 'row-1' }))?.text).toBe(ROW_PUSH)
    expect((await ui.find({ type: 'Box', key: 'row-2' }))?.text).toBe(ROW_ENV)
    // the name bold, the tool dim; 2× bold in the warn tone, 0× dim
    const name = await ui.find({ type: 'Text', text: /^no-pkill/ })
    expect(name?.props.bold).toBe(true)
    expect(name?.props.mono).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^Write/ }))?.props.dimColor).toBe(true)
    const fired = await ui.find({ type: 'Text', text: '2×' })
    expect(fired?.props.color).toBe('warning')
    expect(fired?.props.bold).toBe(true)
    const quiet = await ui.findAll({ type: 'Text', text: '0×' })
    expect(quiet.length).toBe(2)
    expect(quiet.every(t => t.props.dimColor === true && t.props.color === undefined)).toBe(true)
    const foot = await ui.find({ type: 'Box', key: 'foot' })
    expect(foot?.text).toBe('3 rules · 2 refusals this session · rules file ~/.claude-mods/command-guard.json')
    expect((await ui.find({ type: 'Text', text: /^3 rules/ }))?.props.dimColor).toBe(true)
    await ui.unmount()
  }
})

test('/guard with no rules file or a broken one says so in the footnote, in the bad tone', async ($, on) => {
  const file: { text: string; mtimeMs: number } = { text: '{ "rules": [', mtimeMs: 1 }
  let exists = false
  on('process.run', () => ran(`${HOME}\n`))
  on('fs.stat', (_, e) => {
    if (!exists || e.path !== FILE) throw new Error('ENOENT')
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', () => ({ value: file.text }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'guard' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const missing = await $.command.run(RUN)
  expect(missing.text).toContain('no rules file at ~/.claude-mods/command-guard.json, so nothing is checked')
  exists = true
  const broken = await $.command.run(RUN)
  expect(broken.text).toContain('not valid JSON')

  for (const text of [missing.text ?? '', broken.text ?? '']) {
    const ui = await $.ui.mount({
      plugin: 'command-guard', surface: 'terminal', component: 'CommandOutput',
      props: { command: 'guard', args: '', text, isErrored: false },
    })
    const foot = await ui.find({ type: 'Text', text: /rules file|no rules file/ })
    expect(foot?.props.color).toBe('error')
    expect(await ui.find({ type: 'Box', key: 'row-0' })).toBe(undefined)
    await ui.unmount()
  }
})

test('guardReply: a long reason is cut to 60 characters; an absolute path stays as given', () => {
  const loaded = parseRules(JSON.stringify([{ name: 'r', pattern: 'x', reason: 'a'.repeat(100) }]))
  const reply = guardReply(loaded, {}, '/etc/guard.json')
  const row = reply.rows[0]?.map(p => p.text).join('') ?? ''
  expect(row.endsWith(`${'a'.repeat(59)}…`)).toBe(true)
  expect(reply.foot).toBe('1 rule · 0 refusals this session · rules file /etc/guard.json')
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
