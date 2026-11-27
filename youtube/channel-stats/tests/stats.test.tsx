import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { compact, parseChannels, statsTable } from '../hooks/register'

const HOME = '/home/demo'
const FILE = `${HOME}/.claude-mods/channel-stats.json`
const NOW = Date.UTC(2027, 0, 15, 1, 0) // 11:00 on 2027-01-15 at +1000
const CHANNELS = JSON.stringify([
  { id: 'UC0000000000000000000001', label: 'Demo Animals' },
  { handle: '@DemoSpace' },
])

type Item = { id: string; title: string; subs: number; views: number; videos: number }
const answer = (items: Item[]) => ({
  value: {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({
      items: items.map(i => ({
        id: i.id,
        snippet: { title: i.title },
        statistics: { subscriberCount: String(i.subs), viewCount: String(i.views), videoCount: String(i.videos), hiddenSubscriberCount: false },
      })),
    }),
  },
})
const ANIMALS = { id: 'UC0000000000000000000001', title: 'Demo Animals Channel', subs: 412, views: 18234, videos: 9 }
const SPACE = { id: 'UC0000000000000000000002', title: 'Demo Space', subs: 38, views: 950, videos: 2 }

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** The engine beneath the plugin: files, the time zone, the clock and the store. Records status lines and requests. */
const engine = (on: On, store: Record<string, unknown> = {}) => {
  const statuses: (string | undefined)[] = []
  const requests: { url: string; key: string | undefined }[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'channel-stats' } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('process.run', () => ran('+1000\n'))
  on('fs.read', (_, e) => {
    if (e.path !== FILE) throw new Error('ENOENT')
    return { value: CHANNELS }
  })
  mock.env(on, { HOME })
  mock.store(on, store)
  const clock = mock.clock(on, { now: NOW })
  return { statuses, requests, clock }
}

/** `/channel-stats` typed at the prompt. */
const RUN = { command: 'channel-stats', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const OPTIONS = { options: { apiKey: 'test-key-not-real' } }

test('the status line and /channel-stats show the numbers the API answers', OPTIONS, async ($, on) => {
  const { statuses, requests } = engine(on, {
    daily: { '2027-01-14': { 'id:UC0000000000000000000001': { subs: 400, views: 17000, videos: 8 } } },
  })
  on('http.fetch', (_, e) => {
    requests.push({ url: e.url, key: e.init?.headers?.['x-goog-api-key'] })
    return answer(e.url.includes('forHandle=') ? [SPACE] : [ANIMALS])
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await $.command.run(RUN)

  expect(statuses[statuses.length - 1]).toBe('Demo Animals 412/1k subs · 18.2k views │ Demo Space 38/1k subs · 950 views')
  // ids in one request, a handle in its own; the key rides in a header, never the URL
  expect(requests.map(r => r.url)).toEqual([
    'https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=UC0000000000000000000001',
    'https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&forHandle=%40DemoSpace',
  ])
  expect(requests.every(r => r.key === 'test-key-not-real' && !r.url.includes('key='))).toBe(true)
  // change since the last earlier day kept (2027-01-14); a channel with no earlier numbers shows none
  expect(out.text?.split('\n').slice(0, 5).join('\n')).toBe([
    '```',
    'Channel            Subs  to 1k            Views  Videos',
    'Demo Animals  412 (+12)    588  18,234 (+1,234)  9 (+1)',
    'Demo Space           38    962              950       2',
    '```',
  ].join('\n'))
  expect(out.text).toContain('Changes since 2027-01-14.')
})

test('a key in ~/.claude-mods/youtube-api-key is used when no key is set', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const requests: { url: string; key?: string }[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'channel-stats' } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('process.run', () => ran('+1000\n'))
  on('fs.read', (_, e) => {
    if (e.path === `${HOME}/.claude-mods/youtube-api-key`) return { value: 'file-key-not-real\n' }
    if (e.path === FILE) return { value: CHANNELS }
    throw new Error('ENOENT')
  })
  on('http.fetch', (_, e) => {
    requests.push({ url: e.url, key: e.init?.headers?.['x-goog-api-key'] })
    return answer(e.url.includes('forHandle=') ? [SPACE] : [ANIMALS])
  })
  mock.env(on, { HOME })
  mock.store(on, {})
  mock.clock(on, { now: NOW })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN)

  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every(r => r.key === 'file-key-not-real')).toBe(true)
  expect(statuses[statuses.length - 1]).toContain('Demo Animals 412/1k subs')
})

test('no API key: the hint, and nothing fetched', async ($, on) => {
  const { statuses } = engine(on)
  let fetched = 0
  on('http.fetch', () => {
    fetched += 1
    return answer([ANIMALS])
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await $.command.run(RUN)

  expect(statuses).toEqual(['channel-stats: set a YouTube API key'])
  expect(out.text).toContain('set a YouTube API key')
  expect(fetched).toBe(0)
})

test('an HTTP error keeps the last good numbers', OPTIONS, async ($, on) => {
  const { statuses, clock } = engine(on)
  let failing = false
  on('http.fetch', (_, e) =>
    failing
      ? { value: { status: 403, ok: false, headers: {}, text: JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }) } }
      : answer(e.url.includes('forHandle=') ? [SPACE] : [ANIMALS]),
  )

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN)
  const good = statuses[statuses.length - 1]
  expect(good).toBe('Demo Animals 412/1k subs · 18.2k views │ Demo Space 38/1k subs · 950 views')

  failing = true
  await clock.advance(30 * 60 * 1000)
  const out = await $.command.run(RUN)
  expect(statuses[statuses.length - 1]).toBe(good)
  expect(out.text).toContain('412')
  expect(out.text).toContain('HTTP 403 quotaExceeded')
})

test('channels file, number format and an empty history', () => {
  expect(parseChannels('[{"id":"UCabc"},{"handle":"name","label":"Mine"},{"x":1}]')).toEqual([
    { id: 'UCabc', label: undefined },
    { handle: '@name', label: 'Mine' },
  ])
  expect(parseChannels('not json')).toEqual([])
  expect(compact(999)).toBe('999')
  expect(compact(1000)).toBe('1k')
  expect(compact(18234)).toBe('18.2k')
  expect(compact(2_450_000)).toBe('2.5M')
  expect(statsTable([{ handle: '@x' }], {}, {}, '2027-01-15', 0, '')).toContain('No earlier day kept yet')
})
