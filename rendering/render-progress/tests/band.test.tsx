import { expect, test } from 'claude-code/testing'

import { alertFor, barPieces, channelColor, commandRow, short } from '../hooks/register'

const HOME = '/home/demo'
const REG = `${HOME}/.render-progress`
const WORK = '/tmp/render-demo'
const NOW = Date.UTC(2027, 0, 15, 7, 30) // ms
const START = NOW / 1000 - 3600 // started an hour ago

const files: Record<string, { text: string; mtimeMs: number }> = {
  [`${REG}/demo-123`]: {
    text: `kind=remotion\ntitle=Predators Then And Now\nchannel=Demo Channel\nwork=${WORK}\nframes=3000\nstart=${START}\npid=123\n`,
    mtimeMs: NOW,
  },
  [`${WORK}/status`]: { text: 'part1 ok\n', mtimeMs: NOW - 5000 },
  [`${WORK}/part1.log`]: { text: 'Rendered 999/1000, time remaining: 0s\n', mtimeMs: NOW - 5000 },
  [`${WORK}/part2.log`]: { text: 'Rendered 250/1000, time remaining: 9m\nRendered 500/1000, time remaining: 5m\n', mtimeMs: NOW - 1000 },
  [`${WORK}/part3.log`]: { text: 'Rendered 500/1000, time remaining: 5m\n', mtimeMs: NOW - 1000 },
}

const BAND = {
  plugin: 'render-progress',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const entry = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })

// date +%z, the core count, HOME; and ps: the render script (pid 123) with a Remotion child and a Chrome
// grandchild, plus an unrelated busy process
const PS = '  123     1   0.0 /bin/bash render.sh\n  200   123  40.0 node remotion render\n  300   200 210.0 chrome-headless-shell\n  999     1  90.0 something else\n'
const host = (argv: readonly string[], extra?: string) =>
  argv[0] === 'date' ? ran('+0800\n')
    : argv[0] === 'getconf' ? ran('10\n')
    : argv[0] === 'printenv' ? ran(`${HOME}\n`)
    : argv[0] === 'ps' ? ran(PS)
    : ran(extra ?? '')

test('a Remotion render half done shows title, bar, ETA, frames and cores', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', (_, e) => host(e.argv))
  on('fs.list', (_, e) => ({
    value: e.path === REG ? [entry('demo-123')]
      : e.path === WORK ? ['status', 'part1.log', 'part2.log', 'part3.log'].map(entry)
      : [],
  }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.stat', (_, e) => {
    const f = files[e.path]
    if (!f) throw new Error('ENOENT')
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const f = files[e.path]
    if (!f) throw new Error('ENOENT')
    return { value: f.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // part1 finished (its 1000 frames) + 500 + 500 = 2,000 of 3,000 after an hour: 30 min left;
  // 07:30 UTC + 30 min at +0800 is 16:00. 2.5 cores (0.4 + 2.1, not the unrelated 0.9), rounded to 3 of 10
  const line = await ui.find({ type: 'Box', key: 'demo-123' })
  expect(line?.text).toBe('Predators Then And Now[##########66%###--------]ETA:16:002.0k/3.0k3/10c✕')
  // the filled part of the bar is its own coloured piece, and each column its own cell
  expect((await ui.find({ type: 'Text', text: '##########' }))?.props.color).toBe('claude')
  expect((await ui.find({ type: 'Text', text: '3/10c' }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: /^Predators/ }))?.props.color).toBe(channelColor('Demo Channel'))
  await ui.unmount()
})

test('no renders, no band', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', (_, e) => host(e.argv))
  on('fs.list', () => ({ value: [] }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a kind=command render shows what its command reports', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [entry('blender-film')] }))
  on('command.register', () => ({ value: { command: 'renders' } }))
  on('fs.read', () => ({ value: 'kind=command\ntitle=A Blender Film\ncwd=/tmp/film\ncmd=python3 progress.py\ncolor=suggestion\n' }))
  on('process.run', (_, e) => host(e.argv, JSON.stringify({ total: 13482, done: 5000, running: true, started: null, pids: [] })))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // one sample so far: no rate yet, so no estimate; no live pids, so no cores column
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Box', key: 'blender-film' }))?.text).toBe('A Blender Film[#########-37%-----------]ETA:--:--5.0k/13.5k✕')
  // a color= line sets the title's colour
  expect((await ui.find({ type: 'Text', text: /^A Blender/ }))?.props.color).toBe('suggestion')
  // ✕ closes the row; /renders brings it back
  await ui.press({ key: 'close-blender-film' })
  expect(await ui.find({ type: 'Box', key: 'blender-film' })).toBe(undefined)
  const out = await $.command.run({ command: 'renders', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toBe('Render bar shown again.\nA Blender Film: 37%')
  expect((await ui.find({ type: 'Box', key: 'blender-film' }))?.text).toContain('A Blender Film')
  await ui.unmount()
})

test('short numbers, the bar with its percent inside, steady channel colours', () => {
  expect(short(999)).toBe('999')
  expect(short(13482)).toBe('13.5k')
  // 12 cells, half filled; the percent covers cells 4-6, so the fill shows on either side
  expect(barPieces(0.5, 12, '50%', 'claude').map(p => p.text).join('')).toBe('[####50%-----]')
  expect(barPieces(null, 12, 'bundling', 'claude').map(p => p.text).join('')).toBe('[--bundling--]')
  expect(channelColor('Some Channel')).toBe(channelColor('Some Channel'))
  expect(channelColor('')).toBe('text')
})

test('alerts: done and failed only after a change, stalled whenever it starts', () => {
  const row = (stage: 'rendering' | 'done' | 'failed' | 'stalled') => ({
    id: 'r', title: 'My Film', channel: '', kind: 'remotion' as const, stage,
    fraction: 0.5, framesDone: 1, framesTotal: 2, elapsedSec: 3725, leftSec: null,
  })
  expect(alertFor(row('done'), 'rendering')).toBe('My Film: render done in 1:02:05')
  expect(alertFor(row('failed'), 'joining')).toBe('My Film: render FAILED after 1:02:05')
  expect(alertFor(row('stalled'), 'rendering')).toBe('My Film: no progress for 15 minutes')
  // already finished when first seen (say, after a reload): no alert; no change: no alert
  expect(alertFor(row('done'), undefined)).toBe(undefined)
  expect(alertFor(row('done'), 'done')).toBe(undefined)
  expect(alertFor(row('rendering'), 'bundling')).toBe(undefined)
})

test('a command render with every frame is done, and leaves 2 hours after it finished', () => {
  const base = { id: 'film', title: 'A Film', channel: '' }
  const now = 1_800_000_000
  const all = { total: 100, done: 100, running: false, started: now - 3600, finished: now - 600 }
  const row = commandRow(base, all, [], now)
  expect(row?.stage).toBe('done')
  expect(row?.fraction).toBe(1)
  // started to finished: 50 minutes
  expect(row?.elapsedSec).toBe(3000)
  // finished more than 2 hours ago: gone, so a new session does not show an old render
  expect(commandRow(base, { ...all, finished: now - 3 * 3600 }, [], now)).toBe(undefined)
  // not all frames and nothing running: nothing to show
  expect(commandRow(base, { ...all, done: 50 }, [], now)).toBe(undefined)
  // not all frames and running: rendering
  expect(commandRow(base, { ...all, done: 50, running: true }, [], now)?.stage).toBe('rendering')
})
