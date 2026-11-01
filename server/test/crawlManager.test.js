import test from 'node:test'
import assert from 'node:assert/strict'
import { CrawlManagerError, createCrawlManager } from '../src/crawlManager.js'
import { CRAWL_EVENTS, createEvent } from '../src/events.js'
import { UrlGuardError } from '../src/urlGuard.js'

const approve = async (input) => ({ url: new URL(input), addresses: [] })
const settle = () => new Promise((resolve) => setImmediate(resolve))

// A fake crawl: started, fetched, completed. With `hold` it waits until stopped; with `fail` it throws.
function fakeRun({ hold = false, fail = false } = {}) {
  return async (rootUrl, { emit, signal }, { crawlId }) => {
    let seq = 0
    const send = (type, payload) => emit(createEvent(type, crawlId, seq++, payload))
    send(CRAWL_EVENTS.STARTED, { rootUrl })
    if (fail) throw new Error('boom')
    if (hold) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    else send(CRAWL_EVENTS.PAGE_FETCHED, { url: rootUrl })
    const reason = signal.aborted ? 'stopped' : 'done'
    send(CRAWL_EVENTS.COMPLETED, { pages: 1, links: 0, errors: 0, reason })
    return { crawlId, pages: 1, links: 0, errors: 0, attempts: 1, reason }
  }
}

test('starts a crawl, buffers its events and replays them to late subscribers', async () => {
  const manager = createCrawlManager({ run: fakeRun(), validate: approve })
  const crawl = await manager.start({ url: 'https://example.com/' })
  assert.match(crawl.crawlId, /^[0-9a-f-]{36}$/)
  assert.equal(crawl.status, 'running')

  await settle()
  assert.equal(manager.get(crawl.crawlId).status, 'finished')

  const received = []
  const subscription = manager.subscribe(crawl.crawlId, (event) => received.push(event.type))
  assert.deepEqual(received, ['crawl:started', 'page:fetched', 'crawl:completed'])
  assert.equal(subscription.replayed, 3)
  assert.equal(subscription.gap, false)
})

test('afterSeq skips events the subscriber already has', async () => {
  const manager = createCrawlManager({ run: fakeRun(), validate: approve })
  const { crawlId } = await manager.start({ url: 'https://example.com/' })
  await settle()
  const received = []
  manager.subscribe(crawlId, (event) => received.push(event.seq), { afterSeq: 0 })
  assert.deepEqual(received, [1, 2])
})

test('stop() aborts a running crawl and listeners see the final event', async () => {
  const manager = createCrawlManager({ run: fakeRun({ hold: true }), validate: approve })
  const { crawlId } = await manager.start({ url: 'https://example.com/' })
  await settle()

  const received = []
  manager.subscribe(crawlId, (event) => received.push(event))
  assert.equal(received.length, 1) // the replayed crawl:started

  assert.equal(manager.stop(crawlId).status, 'stopping')
  await settle()
  assert.equal(received.at(-1).type, CRAWL_EVENTS.COMPLETED)
  assert.equal(received.at(-1).reason, 'stopped')
  assert.equal(manager.get(crawlId).status, 'stopped')
})

test('refuses new crawls past the concurrency limit and frees the slot afterwards', async () => {
  const manager = createCrawlManager({ run: fakeRun({ hold: true }), validate: approve, maxConcurrent: 1 })
  const first = await manager.start({ url: 'https://example.com/' })
  await assert.rejects(
    manager.start({ url: 'https://example.org/' }),
    (error) => error instanceof CrawlManagerError && error.code === 'TOO_MANY_CRAWLS',
  )
  manager.stop(first.crawlId)
  await settle()
  const second = await manager.start({ url: 'https://example.org/' })
  assert.equal(second.status, 'running')
  manager.shutdown()
})

test('a rejected URL starts nothing and does not use up a slot', async () => {
  let rejectNext = true
  const validate = async (input) => {
    if (rejectNext) {
      rejectNext = false
      throw new UrlGuardError('IP_BLOCKED', 'blocked')
    }
    return approve(input)
  }
  const manager = createCrawlManager({ run: fakeRun({ hold: true }), validate, maxConcurrent: 1 })
  await assert.rejects(manager.start({ url: 'http://127.0.0.1/' }), (error) => error.code === 'IP_BLOCKED')
  const crawl = await manager.start({ url: 'https://example.com/' })
  assert.equal(crawl.status, 'running')
  manager.shutdown()
})

test('a crawl that throws ends with a failed crawl:completed event', async () => {
  const manager = createCrawlManager({ run: fakeRun({ fail: true }), validate: approve })
  const { crawlId } = await manager.start({ url: 'https://example.com/' })
  await settle()
  assert.equal(manager.get(crawlId).status, 'failed')

  const events = []
  manager.subscribe(crawlId, (event) => events.push(event))
  assert.deepEqual(events.map((event) => event.type), ['crawl:started', 'crawl:completed'])
  assert.equal(events[1].reason, 'failed')
  assert.equal(events[1].seq, 1)
})

test('a throwing listener does not break the crawl or other listeners', async () => {
  const manager = createCrawlManager({ run: fakeRun({ hold: true }), validate: approve })
  const { crawlId } = await manager.start({ url: 'https://example.com/' })
  await settle()
  const received = []
  manager.subscribe(crawlId, () => {
    throw new Error('listener bug')
  })
  manager.subscribe(crawlId, (event) => received.push(event.type))
  manager.stop(crawlId)
  await settle()
  assert.equal(received.at(-1), 'crawl:completed')
})

test('finished crawls are forgotten after the retention period', async () => {
  let clock = 1000
  const manager = createCrawlManager({ run: fakeRun(), validate: approve, retentionMs: 5000, now: () => clock })
  const { crawlId } = await manager.start({ url: 'https://example.com/' })
  await settle()
  clock += 4999
  assert.ok(manager.get(crawlId))
  clock += 2
  assert.equal(manager.get(crawlId), null)
})

test('a full event buffer drops the oldest events and reports a gap', async () => {
  const run = async (rootUrl, { emit }, { crawlId }) => {
    for (let seq = 0; seq < 600; seq++) {
      emit(createEvent(CRAWL_EVENTS.LINK_DISCOVERED, crawlId, seq, { fromUrl: rootUrl, toUrl: `${rootUrl}${seq}`, text: '', scope: 'internal' }))
    }
    return { reason: 'done' }
  }
  const manager = createCrawlManager({ run, validate: approve, bufferLimit: 2 })
  const { crawlId } = await manager.start({ url: 'https://example.com/' })
  await settle()

  const everything = manager.subscribe(crawlId, () => {})
  assert.equal(everything.gap, true)
  assert.ok(everything.replayed < 600)

  const upToDate = manager.subscribe(crawlId, () => {}, { afterSeq: 599 })
  assert.equal(upToDate.gap, false)
  assert.equal(upToDate.replayed, 0)
})

test('unknown crawl ids return null', () => {
  const manager = createCrawlManager({ run: fakeRun(), validate: approve })
  assert.equal(manager.get('nope'), null)
  assert.equal(manager.stop('nope'), null)
  assert.equal(manager.subscribe('nope', () => {}), null)
})