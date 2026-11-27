import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { crossing, isHeavy, parseDf, parseGpu, parseSwap, statusText } from '../hooks/register'

const HOME = '/home/demo'
const CONFIG = `${HOME}/.claude-mods/machine-monitor.json`
const TMP = '/tmp/demo'

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const failed = () => ({ value: { exitCode: 1, stdout: '', stderr: 'nope', isStdoutTruncated: false, isStderrTruncated: false } })
const entry = (name: string) => ({ name, kind: 'dir' as const, size: 1, mtimeMs: 0, isLink: false })

const DF = (freeKb: number) =>
  `Filesystem 1024-blocks      Used Available Capacity iused ifree %iused  Mounted on\n/dev/disk3s1 482797652 400000000 ${freeKb}    96% 1 1 2%   /System/Volumes/Data\n`

/** The Mac as the mod sees it: `load` is the 1-minute load, `du` what du prints. */
const host = (argv: readonly string[], load: string, opts: { gpu?: boolean; freeKb?: number; du?: string } = {}) => {
  switch (argv[0]) {
    case 'printenv': return ran(`${HOME}\n`)
    case 'getconf': return ran('10\n')
    case 'sysctl': return argv[2] === 'vm.loadavg'
      ? (load ? ran(`{ ${load} 5.10 4.33 }\n`) : failed())
      : ran('total = 6144.00M  used = 4915.20M  free = 1228.80M  (encrypted)\n')
    case 'ioreg': return opts.gpu === false ? failed() : ran('| |   "PerformanceStatistics" = {"Device Utilization %"=100,"Renderer Utilization %"=99}\n')
    case 'df': return ran(DF(opts.freeKb ?? 41 * 1048576))
    case 'du': return ran(opts.du ?? '')
    default: return failed()
  }
}

const setup = (on: On, load: string, opts: { gpu?: boolean; freeKb?: number; du?: string; config?: string } = {}) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => host(e.argv, load, opts))
  // no config file: the mod reads '{}' as all defaults
  on('fs.read', (_, e) => ({ value: e.path === CONFIG && opts.config ? opts.config : '{}' }))
  on('fs.list', (_, e) => ({ value: e.path === TMP ? ['bundle-1', 'bundle-2', 'other'].map(entry) : [] }))
  on('fs.exists', () => ({ value: false }))
  // what the mod shows: status lines, toasts and notifications, in order
  const seen = { lines: [] as (string | undefined)[], toasts: [] as string[], notes: [] as string[] }
  on('ui.status', (_, e) => { seen.lines.push(e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.notify', (_, e) => { seen.notes.push(e.text); return { value: { isSent: false, reason: 'no-channel' } } })
  return seen
}

test('the status line reads load, GPU, swap and disk from the commands', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { lines } = setup(on, '6.21')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(lines[lines.length - 1]).toBe('load 6.2/10 · GPU 100% · swap 4.8/6.0G · disk 41G free')
})

test('a command that fails is left out of the status line', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { lines } = setup(on, '', { gpu: false })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(lines[lines.length - 1]).toBe('swap 4.8/6.0G · disk 41G free')
})

test('the guard refuses a heavy command while the load is over the limit', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup(on, '34.40')
  let ranCommand = false
  on('tool.call', () => { ranCommand = true; return { result: {} } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call({ tool: 'Bash', command: 'npx remotion render src/index.ts Film out.mp4' })
  expect(res.deny).toBe('Machine load is 34 (limit 20). Wait a few minutes and retry; check with uptime.')
  expect(ranCommand).toBe(false)
})

test('the guard lets a heavy command through under the limit', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup(on, '12.00')
  let ranCommand = false
  on('tool.call', () => { ranCommand = true; return { result: {} } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call({ tool: 'Bash', command: 'ffmpeg -i in.mov out.mp4' })
  expect(res.deny).toBe(undefined)
  expect(ranCommand).toBe(true)
})

test('the guard honours the configured limit', { options: { loadLimit: 40 } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup(on, '34.40')
  let ranCommand = false
  on('tool.call', () => { ranCommand = true; return { result: {} } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'blender -b scene.blend -a' })
  expect(ranCommand).toBe(true)
})

test('non-heavy commands run whatever the load', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup(on, '99.00')
  let calls = 0
  on('tool.call', () => { calls += 1; return { result: {} } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: 'ls renders/' })
  expect(calls).toBe(2)
})

test('a load that cannot be read lets heavy commands run', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup(on, '')
  let calls = 0
  on('tool.call', () => { calls += 1; return { result: {} } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call({ tool: 'Bash', command: 'npx remotion render Film out.mp4' })
  expect(res.deny).toBe(undefined)
  expect(calls).toBe(1)
})

test('heavy patterns come from the config file', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  setup(on, '50.00', { config: JSON.stringify({ heavyPatterns: ['make video'] }) })
  let calls = 0
  on('tool.call', () => { calls += 1; return { result: {} } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // ffmpeg is no longer on the list; `make video` is
  await $.tool.call({ tool: 'Bash', command: 'ffmpeg -i a b' })
  const res = await $.tool.call({ tool: 'Bash', command: 'make video' })
  expect(calls).toBe(1)
  expect(res.deny).toBe('Machine load is 50 (limit 20). Wait a few minutes and retry; check with uptime.')
})

test('low disk and big temp folders warn once per crossing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // 10 GB free; two matching bundles of 15 GB each
  const { toasts, notes, lines } = setup(on, '3.00', {
    freeKb: 10 * 1048576,
    du: `${15 * 1048576}\t${TMP}/bundle-1\n${15 * 1048576}\t${TMP}/bundle-2\n`,
    config: JSON.stringify({ tempGlobs: [`${TMP}/bundle-*`] }),
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  await clock.advance(5000)
  await clock.advance(5000)

  expect(toasts.filter(t => t.startsWith('Only 10 GB free')).length).toBe(1)
  expect(toasts.filter(t => t.startsWith('Temp folders hold 30 GB')).length).toBe(1)
  expect(notes.length).toBe(2)
  expect(lines[lines.length - 1]).toBe('load 3.0/10 · GPU 100% · swap 4.8/6.0G · disk 10G free · temp 30G')
})

test('parsers and the pattern match', () => {
  expect(isHeavy('cd kit && npx remotion still Film x.png', ['remotion still'])).toBe(true)
  expect(isHeavy('./scripts/render-film.sh 10', ['render-film.sh'])).toBe(true)
  expect(isHeavy('/Applications/Blender.app/Contents/MacOS/Blender -b f.blend', ['blender -b'])).toBe(true)
  expect(isHeavy('ffprobe in.mp4', ['ffmpeg'])).toBe(false)
  expect(parseSwap('total = 2.00G  used = 512.00M  free = 1.50G')).toEqual({ usedGb: 0.5, totalGb: 2 })
  expect(parseDf('garbage')).toBe(undefined)
  expect(parseGpu('"Device Utilization %"=12 "Device Utilization %"=40')).toBe(40)
  expect(statusText({})).toBe(undefined)
  expect(crossing(false, 19, 20, true)).toBe('raise')
  expect(crossing(true, 20.5, 20, true)).toBe(undefined)
  expect(crossing(true, 21.5, 20, true)).toBe('clear')
})
