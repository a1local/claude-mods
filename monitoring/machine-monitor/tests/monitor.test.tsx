import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { crossing, isHeavy, machineReply, parseDf, parseDisk, parseGpu, parseSwap, statusText, toneOf, unexpandHome } from '../hooks/register'

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
    case 'date': return ran('+1000\n')
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
  on('command.register', () => ({ value: { command: 'machine' } }))
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

  expect(toasts.filter(t => t === 'Disk: only 10 GB free on ~').length).toBe(1)
  expect(toasts.filter(t => t === 'Temp folders: 30 GB (limit 20 GB)').length).toBe(1)
  expect(notes.length).toBe(2)
  expect(notes).toContain('Disk: only 10 GB free on ~')
  expect(lines[lines.length - 1]).toBe('load 3.0/10 · GPU 100% · swap 4.8/6.0G · disk 10G free · temp 30G')
})

test('parsers and the pattern match', () => {
  expect(isHeavy('cd kit && npx remotion still Film x.png', ['remotion still'])).toBe(true)
  expect(isHeavy('./scripts/render-film.sh 10', ['render-film.sh'])).toBe(true)
  expect(isHeavy('/Applications/Blender.app/Contents/MacOS/Blender -b f.blend', ['blender -b'])).toBe(true)
  expect(isHeavy('ffprobe in.mp4', ['ffmpeg'])).toBe(false)
  // text a command writes is not a command it runs: here-documents and single-quoted text are skipped
  expect(isHeavy("python3 - <<'EOF'\ns = 'npx remotion render x'\nEOF\necho done", ['remotion render'])).toBe(false)
  expect(isHeavy('cat > notes.md <<EOF\nrun blender -b later\nEOF', ['blender -b'])).toBe(false)
  expect(isHeavy("grep -n 'remotion render' PLAYBOOK.md", ['remotion render'])).toBe(false)
  expect(isHeavy("cat <<'EOF' > a.txt\nx\nEOF\nnpx remotion render b/ Film out.mp4", ['remotion render'])).toBe(true)
  expect(parseSwap('total = 2.00G  used = 512.00M  free = 1.50G')).toEqual({ usedGb: 0.5, totalGb: 2 })
  expect(parseDf('garbage')).toBe(undefined)
  expect(parseGpu('"Device Utilization %"=12 "Device Utilization %"=40')).toBe(40)
  expect(statusText({})).toBe(undefined)
  expect(crossing(false, 19, 20, true)).toBe('raise')
  expect(crossing(true, 20.5, 20, true)).toBe(undefined)
  expect(crossing(true, 21.5, 20, true)).toBe('clear')
})

/** `/machine` typed at the prompt. */
const RUN = { command: 'machine', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
// 21:45 at +1000
const AT = Date.UTC(2027, 0, 15, 11, 45)

test('/machine answers one row per measure with a bar against its limit', async ($, on) => {
  mock.clock(on, { now: AT })
  setup(on, '6.21')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await $.command.run(RUN)
  expect((out.text ?? '').split('\n')).toEqual([
    'Machine',
    'load    [######----]   62%  6.2 of 10 cores',
    'GPU     [##########]  100%',
    'swap    [########--]   80%  4.8 of 6.0 GB',
    'disk ~  [#########-]   91%  41 GB free of 460 GB',
    'limit 20 · heavy jobs held back above it · updated 21:45',
  ])
})

test('/machine shows the newest measurements, not the ones from the start', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  let load = '6.21'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'machine' } }))
  on('process.run', (_, e) => host(e.argv, load))
  on('fs.read', () => ({ value: '{}' }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  load = '9.50'
  // 4 s later the start's numbers are fresh enough
  await clock.set(AT + 4000)
  expect((await $.command.run(RUN)).text).toContain('6.2 of 10 cores')
  // a minute on, the refresh (or /machine itself, when they are over 10 s old) has measured again
  await clock.set(AT + 60_000)
  expect((await $.command.run(RUN)).text).toContain('9.5 of 10 cores')
})

test('the /machine reply draws in the chat as rows coloured by tone, on terminal and desktop', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  setup(on, '16.00', {
    freeKb: 10 * 1048576,
    du: `${15 * 1048576}\t${TMP}/bundle-1\n${15 * 1048576}\t${TMP}/bundle-2\n`,
    config: JSON.stringify({ tempGlobs: [`${TMP}/bundle-*`] }),
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  const out = await $.command.run(RUN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'machine-monitor', surface, component: 'CommandOutput',
      props: { command: 'machine', args: '', text: out.text ?? '', isErrored: false },
    })
    expect((await ui.find({ type: 'Text', text: 'Machine' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Box', key: 'row-0' }))?.text).toBe('load    [##########]  160%  16.0 of 10 cores')
    expect((await ui.find({ type: 'Box', key: 'row-3' }))?.text).toBe('disk ~  [##########]   98%  10 GB free of 460 GB')
    expect((await ui.find({ type: 'Box', key: 'row-4' }))?.text).toBe('temp    [##########]  150%  30.0 of 20 GB')
    expect((await ui.find({ type: 'Box', key: 'foot' }))?.text).toBe('limit 20 · heavy jobs held back above it · updated 21:45')
    // load 16 of the limit 20 is close to it: warn; GPU full: warn; 10 GB free under the 20 GB warning: bad
    expect((await ui.find({ type: 'Text', text: '160%' }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: ' 98%' }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: '150%' }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: /^load/ }))?.props.mono).toBe(true)
    await ui.unmount()
  }
})

test('the reply\'s tones: good under 70% of the limit, warn above, bad over it', () => {
  expect(toneOf(0.3)).toBe('good')
  expect(toneOf(0.7)).toBe('warn')
  expect(toneOf(1)).toBe('warn')
  expect(toneOf(1.2)).toBe('bad')
  const reply = machineReply({ load: 3, cpus: 10, gpu: 20, swap: { usedGb: 5.5, totalGb: 6 }, disks: [], loadLimit: 20, freeGbWarn: 20, tempGbWarn: 20, at: AT, offsetMin: 600 })
  const colorOf = (row: number, text: string) => reply.rows[row]?.find(p => p.text === text)?.color
  expect(colorOf(0, '###')).toBe('success')
  expect(colorOf(1, '##')).toBe('success')
  expect(colorOf(2, '#########')).toBe('warning')
  expect(machineReply({ disks: [], loadLimit: 20, freeGbWarn: 20, tempGbWarn: 20, offsetMin: 0 }).foot).toContain('not measured yet')
  expect(parseDisk(DF(41 * 1048576))?.freeGb).toBe(41)
  expect(unexpandHome(`${HOME}/Renders`, HOME)).toBe('~/Renders')
  expect(unexpandHome('/Volumes/Scratch', HOME)).toBe('/Volumes/Scratch')
})

test('only programs being run count, not words in their arguments', () => {
  const heavy = ['remotion render', 'remotion still', 'blender -b', 'ffmpeg', 'render-episode.sh']
  // run: held back over the limit
  for (const cmd of [
    'cd kit && npx remotion render /tmp/b Film out.mp4',
    'nohup /opt/homebrew/bin/blender -b --factory-startup -P film.py -- 06-03 --anim &',
    'FOO=1 nice -n 5 ffmpeg -i in.mov out.mp4',
    'cd kit && scripts/render-episode.sh ep10 ../out.mp4',
    'bash kit/scripts/render-episode.sh ep10 out.mp4',
    'npm exec remotion still src/x.tsx Thumb t.png',
    'ls && ffmpeg -version',
  ]) expect([cmd, isHeavy(cmd, heavy)]).toEqual([cmd, true])
  // only mentioned: let through (each of these was refused before)
  for (const cmd of [
    'ps -axo pid,command | grep -E "remotion|Blender|blender|ffmpeg|render-episode"',
    'grep -c "progress" kit/scripts/render-episode.sh',
    'ls kit/scripts/render-episode.sh',
    'echo "run ffmpeg later"',
    'git log --oneline -- kit/scripts/render-episode.sh',
    'ffprobe in.mp4',
  ]) expect([cmd, isHeavy(cmd, heavy)]).toEqual([cmd, false])
})
