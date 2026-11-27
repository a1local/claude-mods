import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { nameColor } from '../hooks/look'
import { bandRows, localMs, parseSchedule, scheduleReply, span, statusOf } from '../hooks/register'

const HOME = '/home/demo'
const FILE = `${HOME}/.claude-mods/schedule.json`
const OFFSET = 8 * 60 // +0800
// 15 Jan 2027, 13:30 local (05:30 UTC)
const NOW = Date.UTC(2027, 0, 15, 5, 30)

// out of order on purpose: the reply sorts by time
const ITEMS = [
  { at: '2027-01-16T00:05', channel: 'Demo Channel', kind: 'film', title: 'Tomorrow Film', platforms: ['youtube'], scheduled: true },
  { at: '2027-01-15T14:00', channel: 'Demo Channel', kind: 'short', title: 'Soon Short', platforms: ['youtube', 'facebook'] },
  { at: '2027-01-15T00:05', channel: 'Demo Channel', kind: 'film', title: 'Morning Film', scheduled: true },
  { at: '2027-01-15T09:05', channel: 'Other Channel', kind: 'short', title: 'Missed Short', platforms: ['tiktok'], color: 'merged' },
  { at: '2027-01-15T13:00', channel: 'Demo Channel', kind: 'short', title: 'Posted Short', done: true },
  { at: '2027-01-15T17:05', channel: 'Demo Channel', kind: 'short', title: 'Evening Short' },
  { at: '2027-01-17T09:05', channel: 'Demo Channel', kind: 'short', title: 'Too Far Ahead' },
]

const BAND = {
  plugin: 'publish-schedule',
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

const run = (args = '') => ({ command: 'publishing', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const)

const output = (surface: 'terminal' | 'desktop', text: string) => ({
  plugin: 'publish-schedule', surface, component: 'CommandOutput',
  props: { command: 'publishing', args: '', text, isErrored: false },
} as const)

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** The engine beneath the mod: a clock, `date +%z`, HOME, and the schedule file in memory. */
const engine = (on: On, items: unknown[] | null, nowMs = NOW) => {
  const disk = { text: JSON.stringify(items, null, 2), writes: 0 }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'publishing' } }))
  on('clock.now', () => ({ value: nowMs }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', (_, e) => (e.argv[0] === 'date' ? ran('+0800\n') : e.argv[0] === 'printenv' ? ran(`${HOME}\n`) : ran('')))
  on('fs.read', (_, e) => {
    if (e.path !== FILE || items === null) throw new Error('ENOENT')
    return { value: disk.text }
  })
  on('fs.write', (_, e) => {
    if (e.path === FILE) {
      disk.text = e.text
      disk.writes += 1
    }
    return { value: undefined }
  })
  return disk
}

test('/publishing answers in the chat: a dim line per day, numbered rows, counts in the footnote', async ($, on) => {
  engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(run())
  expect(out.text?.split('\n')).toEqual([
    'Publishing',
    'Today, Fri 15 Jan',
    '1.  00:05  Demo Channel   Film   Morning Film          done',
    '2.  09:05  Other Channel  Short  Missed Short   TT     overdue 4 h 25 min',
    '3.  13:00  Demo Channel   Short  Posted Short          done',
    '4.  14:00  Demo Channel   Short  Soon Short     YT FB  in 30 min',
    '5.  17:05  Demo Channel   Short  Evening Short         later',
    'Tomorrow, Sat 16 Jan',
    '6.  00:05  Demo Channel   Film   Tomorrow Film  YT     scheduled',
    '2 due today · 1 overdue · updated 13:30',
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(output(surface, out.text ?? ''))
    expect((await ui.find({ type: 'Text', text: 'Publishing' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Box', key: 'row-0' }))?.text).toBe('Today, Fri 15 Jan')
    expect((await ui.find({ type: 'Text', text: 'Today, Fri 15 Jan' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Box', key: 'row-2' }))?.text).toBe('2.  09:05  Other Channel  Short  Missed Short   TT     overdue 4 h 25 min')
    expect((await ui.find({ type: 'Box', key: 'row-6' }))?.text).toBe('Tomorrow, Sat 16 Jan')
    expect(await ui.find({ type: 'Text', text: /Too Far Ahead/ })).toBeUndefined()
    // channels bold in their colour: the entry's own `color`, else the steady colour for the name
    const demo = await ui.find({ type: 'Text', text: 'Demo Channel' })
    expect(demo?.props.color).toBe(nameColor('Demo Channel'))
    expect(demo?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'Other Channel' }))?.props.color).toBe('merged')
    expect((await ui.find({ type: 'Text', text: 'YT FB' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Box', key: 'foot' }))?.text).toBe('2 due today · 1 overdue · updated 13:30')
    await ui.unmount()
  }
})

test('statuses are coloured by tone', async ($, on) => {
  engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await $.command.run(run())
  const ui = await $.ui.mount(output('terminal', out.text ?? ''))
  expect((await ui.find({ type: 'Text', text: 'done' }))?.props.color).toBe('success')
  const overdue = await ui.find({ type: 'Text', text: /^overdue/ })
  expect(overdue?.props.color).toBe('error')
  expect(overdue?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'in 30 min' }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: 'scheduled' }))?.props.color).toBe('suggestion')
  expect((await ui.find({ type: 'Text', text: 'later' }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('/publishing done 2 writes done: true to row 2 and answers the refreshed reply', async ($, on) => {
  const disk = engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(run())
  const out = await $.command.run(run('done 2'))

  expect(disk.writes).toBe(1)
  const saved = JSON.parse(disk.text) as Array<{ title: string; done?: boolean; color?: string }>
  expect(saved.find(i => i.title === 'Missed Short')?.done).toBe(true)
  // the other entries are kept as they were
  expect(saved.find(i => i.title === 'Soon Short')?.done).toBeUndefined()
  expect(saved.find(i => i.title === 'Missed Short')?.color).toBe('merged')
  expect(saved.length).toBe(ITEMS.length)

  const lines = out.text?.split('\n') ?? []
  expect(lines[3]).toBe('2.  09:05  Other Channel  Short  Missed Short   TT     done')
  expect(lines[lines.length - 1]).toBe('marked 2 done · 2 due today · updated 13:30')
  // the reply is drawn as the box too
  const ui = await $.ui.mount(output('desktop', out.text ?? ''))
  expect((await ui.find({ type: 'Box', key: 'foot' }))?.text).toBe('marked 2 done · 2 due today · updated 13:30')
  await ui.unmount()
})

test('/publishing done with no such row writes nothing', async ($, on) => {
  const disk = engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(run('done 9'))
  expect(out.text).toBe('publishing: no row 9. Rows run 1 to 6; /publishing lists them.')
  expect(disk.writes).toBe(0)
})

test('the band: one line, the most urgent first, ‹ 1/2 › to flick; ✕ closes one, /publishing brings it back', async ($, on) => {
  engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const missed = 'publish-schedule:2027-01-15T09:05|Other Channel|Missed Short'
  const soon = 'publish-schedule:2027-01-15T14:00|Demo Channel|Soon Short'
  // one line: the overdue one first, the arrows and 1/2 at the right
  expect((await ui.find({ type: 'Box', key: missed }))?.text).toBe('overdue 4 h 25 min  09:05  Other Channel  Short  Missed Short‹1/2›✕')
  expect(await ui.find({ type: 'Box', key: soon })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^overdue/ }))?.props.color).toBe('error')
  // › shows the next, lined up with the first
  await ui.press({ key: 'band-next' })
  expect((await ui.find({ type: 'Box', key: soon }))?.text).toBe('in 30 min           14:00  Demo Channel   Short  Soon Short‹2/2›✕')
  expect((await ui.find({ type: 'Text', text: 'in 30 min' }))?.props.color).toBe('warning')
  // lines that are done, later or tomorrow stay off the band
  expect(await ui.find({ type: 'Text', text: /Evening Short/ })).toBeUndefined()

  // ✕ closes the one in view; the other is left, alone, with no arrows
  await ui.press({ key: `close-${soon}` })
  expect((await ui.find({ type: 'Box', key: missed }))?.text).toBe('overdue 4 h 25 min  09:05  Other Channel  Short  Missed Short✕')

  await $.command.run(run())
  expect((await ui.find({ type: 'Box', key: 'band-page' }))?.text).toBe('1/2')
  await ui.unmount()
})

test('with render-progress loaded, it draws the shared row and this mod draws none of its own', async ($, on) => {
  engine(on, ITEMS)
  on('state.get', { plugin: 'render-progress' } as never, () => ({ value: { value: { items: [], reset: 0 }, version: 1 } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('nothing within the hour, no band', async ($, on) => {
  // 12:30 local: the 14:00 Short is 90 minutes off, nothing overdue
  engine(on, ITEMS.filter(i => i.title !== 'Missed Short'), NOW - 60 * 60 * 1000)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('no schedule file says so in the reply', async ($, on) => {
  engine(on, null)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(run())
  expect(out.text).toBe(`Publishing\nNo schedule file at ${FILE}`)
})

test('times, spans and statuses', () => {
  const rows = parseSchedule(JSON.stringify({ items: ITEMS }), OFFSET)
  expect(rows.map(r => r.title)[0]).toBe('Morning Film')
  expect(localMs('2027-01-15T13:30', OFFSET)).toBe(NOW)
  expect(Number.isNaN(localMs('tomorrow', OFFSET))).toBe(true)
  expect(span(25 * 60000)).toBe('25 min')
  expect(span(125 * 60000)).toBe('2 h 5 min')
  expect(span(120 * 60000)).toBe('2 h')
  const soon = rows.find(r => r.title === 'Soon Short')
  expect(soon && statusOf(soon, NOW)).toBe('soon')
  expect(bandRows(rows.filter(r => r.title === 'Evening Short'), NOW, OFFSET)).toEqual([])
  expect(scheduleReply([], NOW, OFFSET, NOW).empty).toBe('Nothing to publish today or tomorrow.')
})
