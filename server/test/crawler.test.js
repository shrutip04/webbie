import test from 'node:test'
import assert from 'node:assert/strict'
import { runCrawl, resolveLimits } from '../src/crawler.js'
import { CRAWL_EVENTS } from '../src/events.js'
import { FetchError } from '../src/safeFetch.js'
import { UrlGuardError } from '../src/urlGuard.js'

const page = (links) => `<html><title>T</title>${links.map((href) => `<a href="${href}">x</a>`).join('')}</html>`
const allowAll = { check: async () => ({ allowed: true, crawlDelayMs: null, reason: 'allowed' }) }

// A tiny fake internet: `site` maps URL -> HTML, `redirects` maps URL -> final URL.
// Time is fake too: sleeping just moves the clock, so tests finish instantly.
function makeHarness(site, { robots = allowAll, redirects = {} } = {}) {
  let clock = 1_000
  const sleeps = []
  const fetched = []
  const events = []
  const deps = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    fetchPage: async (url) => {
      fetched.push(url)
      const finalUrl = redirects[url] ?? url
      const html = site[finalUrl]
      if (html === undefined) {
        throw new FetchError('HTTP_STATUS', 'The server answered with status 404.', { status: 404 })
      }
      return { url: finalUrl, status: 200, contentType: 'text/html', bytes: html.length, text: html, redirects: [], durationMs: 5 }
    },
    robots,
    crawlId: 'test-crawl',
  }
  const emit = (event) => events.push(event)
  return {
    fetched,
    sleeps,
    events,
    run: (root, limits, extra = {}) => runCrawl(root, { limits, emit, ...extra }, deps),
  }
}

const ofType = (events, type) => events.filter((event) => event.type === type)

test('crawls breadth-first, stays on the root host, and emits events in order', async () => {
  const h = makeHarness({
    'https://example.com/': page(['/a', '/b', 'https://other.org/z']),
    'https://example.com/a': page(['/c', '/']),
    'https://example.com/b': page([]),
    'https://example.com/c': page([]),
  })
  const summary = await h.run('https://example.com/', { maxDepth: 2, maxPages: 10 })

  assert.deepEqual(h.fetched, [
    'https://example.com/',
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
  ])
  assert.deepEqual(summary, { crawlId: 'test-crawl', pages: 4, links: 5, errors: 0, attempts: 4, reason: 'done' })

  assert.equal(h.events[0].type, CRAWL_EVENTS.STARTED)
  assert.equal(h.events.at(-1).type, CRAWL_EVENTS.COMPLETED)
  assert.deepEqual(h.events.map((event) => event.seq), h.events.map((_, index) => index))
  assert.ok(h.events.every((event) => event.crawlId === 'test-crawl'))

  const external = ofType(h.events, CRAWL_EVENTS.LINK_DISCOVERED).find((event) => event.toUrl === 'https://other.org/z')
  assert.equal(external.scope, 'external')
  assert.equal(external.fromUrl, 'https://example.com/')
  assert.ok(!h.fetched.includes('https://other.org/z'))
})

test('page:fetched reports what was really fetched', async () => {
  const h = makeHarness({ 'https://example.com/': page(['/a', '/b']), 'https://example.com/a': page([]), 'https://example.com/b': page([]) })
  await h.run('https://example.com/')
  const [fetchedEvent] = ofType(h.events, CRAWL_EVENTS.PAGE_FETCHED)
  assert.equal(fetchedEvent.url, 'https://example.com/')
  assert.equal(fetchedEvent.status, 200)
  assert.equal(fetchedEvent.title, 'T')
  assert.equal(fetchedEvent.linkCount, 2)
})

test('crawler:moved names the page where the link was found', async () => {
  const h = makeHarness({ 'https://example.com/': page(['/a']), 'https://example.com/a': page([]) })
  await h.run('https://example.com/')
  const moves = ofType(h.events, CRAWL_EVENTS.CRAWLER_MOVED)
  assert.deepEqual(moves.map((m) => [m.fromUrl, m.toUrl]), [
    [null, 'https://example.com/'],
    ['https://example.com/', 'https://example.com/a'],
  ])
})

test('maxPages stops the crawl and reports reason "limit"', async () => {
  const h = makeHarness({
    'https://example.com/': page(['/1', '/2', '/3', '/4', '/5']),
    'https://example.com/1': page([]),
    'https://example.com/2': page([]),
    'https://example.com/3': page([]),
  })
  const summary = await h.run('https://example.com/', { maxPages: 3 })
  assert.equal(h.fetched.length, 3)
  assert.equal(summary.reason, 'limit')
  assert.equal(ofType(h.events, CRAWL_EVENTS.PAGE_DISCOVERED).length, 3) // the root plus two queued pages
})

test('maxDepth stops going deeper and reports reason "limit"', async () => {
  const h = makeHarness({
    'https://example.com/': page(['/a']),
    'https://example.com/a': page(['/b']),
    'https://example.com/b': page(['/c']),
  })
  const summary = await h.run('https://example.com/', { maxDepth: 1 })
  assert.deepEqual(h.fetched, ['https://example.com/', 'https://example.com/a'])
  assert.equal(summary.reason, 'limit')
})

test('maxDepth 0 visits only the root page', async () => {
  const h = makeHarness({ 'https://example.com/': page(['/a']), 'https://example.com/a': page([]) })
  const summary = await h.run('https://example.com/', { maxDepth: 0 })
  assert.deepEqual(h.fetched, ['https://example.com/'])
  assert.equal(summary.reason, 'limit')
})

test('waits between requests to the same host', async () => {
  const h = makeHarness({ 'https://example.com/': page(['/a', '/b']), 'https://example.com/a': page([]), 'https://example.com/b': page([]) })
  await h.run('https://example.com/', { delayMs: 1000 })
  assert.deepEqual(h.sleeps, [1000, 1000]) // no wait before the very first request
})

test('honors a longer Crawl-delay from robots.txt', async () => {
  const robots = { check: async () => ({ allowed: true, crawlDelayMs: 3000, reason: 'allowed' }) }
  const h = makeHarness({ 'https://example.com/': page(['/a', '/b']), 'https://example.com/a': page([]), 'https://example.com/b': page([]) }, { robots })
  await h.run('https://example.com/', { delayMs: 1000 })
  assert.deepEqual(h.sleeps, [3000, 3000])
})

test('skips a site whose Crawl-delay is unreasonably long', async () => {
  const robots = { check: async () => ({ allowed: true, crawlDelayMs: 60_000, reason: 'allowed' }) }
  const h = makeHarness({ 'https://example.com/': page([]) }, { robots })
  const summary = await h.run('https://example.com/')
  assert.equal(summary.pages, 0)
  assert.equal(ofType(h.events, CRAWL_EVENTS.PAGE_ERROR)[0].code, 'ROBOTS_CRAWL_DELAY_TOO_LONG')
  assert.deepEqual(h.fetched, [])
})

test('pages disallowed by robots.txt are reported and never fetched', async () => {
  const robots = {
    check: async (url) =>
      url.pathname.startsWith('/private')
        ? { allowed: false, crawlDelayMs: null, reason: 'blocked-by-rule' }
        : { allowed: true, crawlDelayMs: null, reason: 'allowed' },
  }
  const h = makeHarness(
    { 'https://example.com/': page(['/private/x', '/open']), 'https://example.com/open': page([]) },
    { robots },
  )
  const summary = await h.run('https://example.com/')
  assert.ok(!h.fetched.includes('https://example.com/private/x'))
  assert.deepEqual(h.fetched, ['https://example.com/', 'https://example.com/open'])
  const [error] = ofType(h.events, CRAWL_EVENTS.PAGE_ERROR)
  assert.equal(error.code, 'ROBOTS_DISALLOWED')
  assert.equal(error.url, 'https://example.com/private/x')
  assert.equal(summary.errors, 1)
})

test('a failed fetch is reported and the crawl continues', async () => {
  const h = makeHarness({ 'https://example.com/': page(['/missing', '/ok']), 'https://example.com/ok': page([]) })
  const summary = await h.run('https://example.com/')
  const [error] = ofType(h.events, CRAWL_EVENTS.PAGE_ERROR)
  assert.equal(error.code, 'HTTP_STATUS')
  assert.equal(error.url, 'https://example.com/missing')
  assert.equal(summary.pages, 2)
  assert.equal(summary.errors, 1)
})

test('nofollow links are reported but never visited', async () => {
  const h = makeHarness({ 'https://example.com/': '<a rel="nofollow" href="/skip">s</a><a href="/go">g</a>', 'https://example.com/go': page([]) })
  await h.run('https://example.com/')
  assert.ok(!h.fetched.includes('https://example.com/skip'))
  assert.ok(h.fetched.includes('https://example.com/go'))
  assert.equal(ofType(h.events, CRAWL_EVENTS.LINK_DISCOVERED).length, 2)
})

test('a redirect to an already crawled page is not counted twice', async () => {
  const h = makeHarness(
    {
      'https://example.com/': page(['/old', '/new']),
      'https://example.com/new': page([]),
    },
    { redirects: { 'https://example.com/old': 'https://example.com/new' } },
  )
  const summary = await h.run('https://example.com/')
  assert.equal(summary.pages, 2)
  assert.equal(summary.errors, 1)
  assert.equal(ofType(h.events, CRAWL_EVENTS.PAGE_ERROR)[0].code, 'DUPLICATE_PAGE')
  assert.equal(ofType(h.events, CRAWL_EVENTS.PAGE_FETCHED).filter((e) => e.url === 'https://example.com/new').length, 1)
})

test('a redirect out of scope is dropped and its links are not read', async () => {
  const h = makeHarness(
    {
      'https://example.com/': page(['/out']),
      'https://evil.org/': page(['/trap']),
    },
    { redirects: { 'https://example.com/out': 'https://evil.org/' } },
  )
  const summary = await h.run('https://example.com/')
  assert.equal(ofType(h.events, CRAWL_EVENTS.PAGE_ERROR)[0].code, 'REDIRECTED_OUT_OF_SCOPE')
  assert.equal(ofType(h.events, CRAWL_EVENTS.LINK_DISCOVERED).some((e) => e.toUrl.includes('trap')), false)
  assert.equal(summary.pages, 1)
})

test('aborting stops the crawl and still sends crawl:completed', async () => {
  const controller = new AbortController()
  const h = makeHarness({ 'https://example.com/': page(['/a', '/b']), 'https://example.com/a': page([]), 'https://example.com/b': page([]) })
  const summary = await h.run('https://example.com/', {}, {
    signal: controller.signal,
    emit: (event) => {
      h.events.push(event)
      if (event.type === CRAWL_EVENTS.PAGE_FETCHED) controller.abort()
    },
  })
  assert.equal(summary.reason, 'stopped')
  assert.equal(h.fetched.length, 1)
  assert.equal(h.events.at(-1).type, CRAWL_EVENTS.COMPLETED)
  assert.equal(h.events.at(-1).reason, 'stopped')
})

test('an invalid root URL throws before any event is sent', async () => {
  const h = makeHarness({})
  await assert.rejects(h.run('http://localhost/'), (error) => error instanceof UrlGuardError && error.code === 'HOST_BLOCKED')
  assert.deepEqual(h.events, [])
})

test('a throwing event listener does not stop the crawl', async () => {
  const h = makeHarness({ 'https://example.com/': page([]) })
  const summary = await h.run('https://example.com/', {}, {
    emit: () => {
      throw new Error('listener bug')
    },
  })
  assert.equal(summary.pages, 1)
})

test('resolveLimits clamps everything into safe bounds', () => {
  assert.deepEqual(resolveLimits({ maxDepth: 99, maxPages: 9999, delayMs: 1 }), { maxDepth: 5, maxPages: 100, delayMs: 500 })
  assert.deepEqual(resolveLimits({ maxDepth: -3, maxPages: 0, delayMs: 999_999 }), { maxDepth: 0, maxPages: 1, delayMs: 30_000 })
  assert.deepEqual(resolveLimits(), { maxDepth: 2, maxPages: 20, delayMs: 1000 })
  assert.deepEqual(resolveLimits({ maxDepth: 'abc', maxPages: NaN, delayMs: undefined }), { maxDepth: 2, maxPages: 20, delayMs: 1000 })
})