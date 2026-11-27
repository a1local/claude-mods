import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bandLine, localMs, parseSchedule, span, statusOf } from '../hooks/register'

const HOME = '/home/demo'
const FILE = `${HOME}/.claude-mods/schedule.json`
const OFFSET = 8 * 60 // +0800
// 15 Jan 2027, 13:30 local (05:30 UTC)
const NOW = Date.UTC(2027, 0, 15, 5, 30)

// out of order on purpose: the pane sorts by time
const ITEMS = [
  { at: '2027-01-16T00:05', channel: 'Demo Channel', kind: 'film', title: 'Tomorrow Film', platforms: ['youtube'] },
  { at: '2027-01-15T14:00', channel: 'Demo Channel', kind: 'short', title: 'Soon Short', platforms: ['youtube', 'facebook'] },
  { at: '2027-01-15T00:05', channel: 'Demo Channel', kind: 'film', title: 'Morning Film', scheduled: true },
  { at: '2027-01-15T09:05', channel: 'Other Channel', kind: 'short', title: 'Missed Short', platforms: ['tiktok'] },
  { at: '2027-01-15T13:00', channel: 'Demo Channel', kind: 'short', title: 'Posted Short', done: true },
  { at: '2027-01-15T17:05', channel: 'Demo Channel', kind: 'short', title: 'Evening Short' },
  { at: '2027-01-17T09:05', channel: 'Demo Channel', kind: 'short', title: 'Too Far Ahead' },
]

const PANE = {
  plugin: 'publish-schedule',
  component: 'Pane',
  requestId: 'publish-schedule',
  props: {
    title: 'Publishing',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

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

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** The engine beneath the mod: a clock, `date +%z`, HOME, and the schedule file in memory. */
const engine = (on: On, items: unknown[] | null, nowMs = NOW) => {
  const disk = { text: JSON.stringify(items, null, 2), writes: 0, opened: [] as string[] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'publishing' } }))
  on('ui.open', (_, e) => {
    disk.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
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

test('the pane lists today and tomorrow in time order, each with its status', async ($, on) => {
  engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = async (title: string) => ui.find({ type: 'Box', key: `${ITEMS.find(i => i.title === title)?.at}|${ITEMS.find(i => i.title === title)?.channel}|${title}` })
    const statusText = async (text: string | RegExp) => ui.find({ type: 'Text', text })

    expect((await ui.find({ type: 'Box', key: '2027-01-15' }))?.text).toMatch(/^Today, Fri 15 Jan00:05/)
    // scheduled and past its time: done
    expect((await row('Morning Film'))?.text).toMatch(/^00:05Demo Channel +Film +Morning Filmdone$/)
    expect((await row('Missed Short'))?.text).toMatch(/^09:05Other Channel *Short *Missed ShortTToverdue 4 h 25 minDone$/)
    expect((await row('Posted Short'))?.text).toMatch(/Posted Shortdone$/)
    expect((await row('Soon Short'))?.text).toMatch(/^14:00.*Soon ShortYT FBin 30 min/)
    expect((await row('Evening Short'))?.text).toMatch(/^17:05.*Evening Shortlater/)
    expect((await row('Tomorrow Film'))?.text).toMatch(/^00:05.*Tomorrow FilmYTlater/)
    expect(await row('Too Far Ahead')).toBeUndefined()

    expect((await statusText('done'))?.props.color).toBe('success')
    expect((await statusText(/^overdue/))?.props.color).toBe('error')
    expect((await statusText('in 30 min'))?.props.color).toBe('warning')

    // time order within today
    const today = (await ui.find({ type: 'Box', key: '2027-01-15' }))?.text ?? ''
    const order = ['Morning Film', 'Missed Short', 'Posted Short', 'Soon Short', 'Evening Short'].map(t => today.indexOf(t))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect((await ui.find({ type: 'Box', key: '2027-01-16' }))?.text).toMatch(/^Tomorrow, Sat 16 Jan/)
    await ui.unmount()
  }
})

test('/publishing opens the pane', async ($, on) => {
  const disk = engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'publishing', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(disk.opened).toEqual(['publish-schedule'])
})

test('Done writes done: true back to the file', async ($, on) => {
  const disk = engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'done:2027-01-15T09:05|Other Channel|Missed Short' })
  expect(disk.writes).toBe(1)
  const saved = JSON.parse(disk.text) as Array<{ title: string; done?: boolean }>
  expect(saved.find(i => i.title === 'Missed Short')?.done).toBe(true)
  // the other entries are kept as they were
  expect(saved.find(i => i.title === 'Soon Short')?.done).toBeUndefined()
  expect(saved.length).toBe(ITEMS.length)

  const row = await ui.find({ type: 'Box', key: '2027-01-15T09:05|Other Channel|Missed Short' })
  expect(row?.text).toMatch(/done$/)
  await ui.unmount()
})

test('the band shows the next item due within the hour', async ($, on) => {
  engine(on, ITEMS.filter(i => i.title !== 'Missed Short'))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Box', key: 'publish-next' }))?.text).toBe('Next:Short 14:00 Demo Channel "Soon Short"(in 30 min)')
  await ui.unmount()
})

test('the band leads with what is overdue', async ($, on) => {
  engine(on, ITEMS)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = await ui.find({ type: 'Box', key: 'publish-next' })
  expect(line?.text).toBe('Overdue:Short 09:05 Other Channel "Missed Short"(4 h 25 min ago) +1 more')
  expect((await ui.find({ type: 'Text', text: 'Overdue:' }))?.props.color).toBe('error')
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

test('no schedule file says so in the pane', async ($, on) => {
  engine(on, null)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No schedule file/ }))?.text).toBe(`No schedule file at ${FILE}`)
  await ui.unmount()
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
  expect(bandLine(rows.filter(r => r.title === 'Evening Short'), NOW, OFFSET)).toBeUndefined()
})
