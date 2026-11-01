import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parseRobots, isPathAllowed, createRobotsChecker, createRobotsFetcher } from '../src/robots.js'

const allowedBy = (robotsText, target) => isPathAllowed(parseRobots(robotsText).rules, target)

// ---------- parsing and matching ----------

test('Disallow blocks by prefix', () => {
  const robots = 'User-agent: *\nDisallow: /private'
  assert.equal(allowedBy(robots, '/private'), false)
  assert.equal(allowedBy(robots, '/private/page'), false)
  assert.equal(allowedBy(robots, '/privately'), false) // prefix match
  assert.equal(allowedBy(robots, '/public'), true)
})

test('the longest matching rule wins', () => {
  const robots = 'User-agent: *\nDisallow: /a\nAllow: /a/b'
  assert.equal(allowedBy(robots, '/a/b/c'), true)
  assert.equal(allowedBy(robots, '/a/c'), false)
  assert.equal(allowedBy(robots, '/a'), false)
})

test('Allow wins a tie between equally specific rules', () => {
  assert.equal(allowedBy('User-agent: *\nDisallow: /x\nAllow: /x', '/x'), true)
})

test('wildcards and the $ end anchor work', () => {
  const robots = 'User-agent: *\nDisallow: /*.pdf$'
  assert.equal(allowedBy(robots, '/docs/file.pdf'), false)
  assert.equal(allowedBy(robots, '/docs/file.pdf?download=1'), true)
  assert.equal(allowedBy(robots, '/docs/file.pdfx'), true)
  assert.equal(allowedBy('User-agent: *\nDisallow: /*/private', '/a/private'), false)
})

test('rules can include the query string', () => {
  const robots = 'User-agent: *\nDisallow: /search?q='
  assert.equal(allowedBy(robots, '/search?q=cats'), false)
  assert.equal(allowedBy(robots, '/search'), true)
})

test('an empty Disallow blocks nothing', () => {
  assert.equal(allowedBy('User-agent: *\nDisallow:', '/anything'), true)
})

test('a group that names us beats the * group', () => {
  const robots = 'User-agent: webbiebot\nDisallow: /secret\n\nUser-agent: *\nDisallow: /'
  assert.equal(allowedBy(robots, '/secret'), false)
  assert.equal(allowedBy(robots, '/open'), true)
})

test('the * group applies when no group names us', () => {
  const robots = 'User-agent: googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /star'
  assert.equal(allowedBy(robots, '/g'), true)
  assert.equal(allowedBy(robots, '/star'), false)
})

test('consecutive User-agent lines share one group', () => {
  assert.equal(allowedBy('User-agent: other\nUser-agent: webbiebot\nDisallow: /z', '/z'), false)
})

test('parsing tolerates BOM, CRLF, comments and mixed case', () => {
  const robots = '\uFEFFUSER-AGENT: WebbieBot # that is us\r\nDISALLOW: /x # why not\r\n'
  assert.equal(allowedBy(robots, '/x'), false)
  assert.equal(allowedBy(robots, '/y'), true)
})

test('rules before any User-agent line are ignored', () => {
  const robots = 'Disallow: /x\nUser-agent: *\nDisallow: /y'
  assert.equal(allowedBy(robots, '/x'), true)
  assert.equal(allowedBy(robots, '/y'), false)
})

test('invalid or oversized patterns are ignored', () => {
  assert.equal(allowedBy('User-agent: *\nDisallow: admin', '/admin'), true)
  assert.equal(parseRobots(`User-agent: *\nDisallow: /${'a'.repeat(600)}`).rules.length, 0)
})

test('a file with no rules for us allows everything', () => {
  assert.equal(allowedBy('<html>Not found</html>', '/anything'), true)
  assert.equal(allowedBy('', '/anything'), true)
})

test('Crawl-delay is read from the group that applies', () => {
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: 5').crawlDelayMs, 5000)
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: abc').crawlDelayMs, null)
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: -3').crawlDelayMs, null)
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: 10\n\nUser-agent: webbiebot\nCrawl-delay: 2').crawlDelayMs, 2000)
})

// ---------- the checker (fetching is faked here) ----------

const fakeFetcher = (outcome) => {
  const calls = []
  const fetchRobots = async (url) => {
    calls.push(url)
    return typeof outcome === 'function' ? outcome(url) : outcome
  }
  return { fetchRobots, calls }
}

test('checker applies the rules and reports why', async () => {
  const { fetchRobots, calls } = fakeFetcher({ status: 'ok', text: 'User-agent: *\nDisallow: /private\nCrawl-delay: 3' })
  const { check } = createRobotsChecker({ fetchRobots })

  const blocked = await check('https://example.com/private/page')
  assert.deepEqual(blocked, { allowed: false, crawlDelayMs: 3000, reason: 'blocked-by-rule' })

  const open = await check('https://example.com/about')
  assert.deepEqual(open, { allowed: true, crawlDelayMs: 3000, reason: 'allowed' })

  assert.deepEqual(calls, ['https://example.com/robots.txt'])
})

test('a missing robots.txt allows crawling', async () => {
  const { fetchRobots } = fakeFetcher({ status: 'missing' })
  const { check } = createRobotsChecker({ fetchRobots })
  assert.deepEqual(await check('https://example.com/x'), { allowed: true, crawlDelayMs: null, reason: 'robots-unavailable' })
})

test('any other failure disallows crawling', async () => {
  const { fetchRobots } = fakeFetcher({ status: 'error', code: 'HTTP_STATUS' })
  const { check } = createRobotsChecker({ fetchRobots })
  assert.deepEqual(await check('https://example.com/x'), { allowed: false, crawlDelayMs: null, reason: 'robots-error' })
})

test('a throwing fetcher is treated as a failure, not a crash', async () => {
  const { check } = createRobotsChecker({
    fetchRobots: async () => {
      throw new Error('boom')
    },
  })
  assert.equal((await check('https://example.com/x')).allowed, false)
})

test('robots.txt itself is always fetchable, and never triggers a fetch of its own', async () => {
  const { fetchRobots, calls } = fakeFetcher({ status: 'error', code: 'TIMEOUT' })
  const { check } = createRobotsChecker({ fetchRobots })
  assert.equal((await check('https://example.com/robots.txt')).allowed, true)
  assert.equal(calls.length, 0)
})

test('policies are cached per origin and concurrent checks share one fetch', async () => {
  const { fetchRobots, calls } = fakeFetcher({ status: 'ok', text: 'User-agent: *\nDisallow:' })
  const { check } = createRobotsChecker({ fetchRobots })

  await Promise.all([check('https://example.com/a'), check('https://example.com/b'), check('https://example.com/c')])
  assert.equal(calls.length, 1)

  await check('https://example.com/d')
  assert.equal(calls.length, 1)

  await check('http://example.com/a') // different scheme = different origin
  await check('https://other.example.com/a') // different host
  assert.equal(calls.length, 3)
})

test('cached policies expire, and failures expire sooner than successes', async () => {
  let clock = 1_000
  const ttlMs = 60 * 60 * 1000
  const okFetch = fakeFetcher({ status: 'ok', text: 'User-agent: *\nDisallow:' })
  const okChecker = createRobotsChecker({ fetchRobots: okFetch.fetchRobots, ttlMs, now: () => clock })

  await okChecker.check('https://example.com/a')
  clock += ttlMs - 1
  await okChecker.check('https://example.com/a')
  assert.equal(okFetch.calls.length, 1)
  clock += 2
  await okChecker.check('https://example.com/a')
  assert.equal(okFetch.calls.length, 2)

  clock = 1_000
  const errFetch = fakeFetcher({ status: 'error', code: 'TIMEOUT' })
  const errChecker = createRobotsChecker({ fetchRobots: errFetch.fetchRobots, ttlMs, now: () => clock })
  await errChecker.check('https://example.com/a')
  clock += 5 * 60 * 1000 + 1
  await errChecker.check('https://example.com/a')
  assert.equal(errFetch.calls.length, 2)
})

// ---------- the real fetcher against a local server ----------

const allowLoopback = async (input) => ({
  url: new URL(input),
  addresses: [{ address: '127.0.0.1', family: 4 }],
})

async function startServer(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  )
  return `http://localhost:${server.address().port}`
}

test('the fetcher maps responses to ok / missing / error', async (t) => {
  const base = await startServer(t, (req, res) => {
    const respond = (status, type, body = '') => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }
    switch (req.url) {
      case '/ok/robots.txt': return respond(200, 'text/plain', 'User-agent: *\nDisallow: /x')
      case '/gone/robots.txt': return respond(404, 'text/html', 'nope')
      case '/removed/robots.txt': return respond(410, 'text/html', 'gone')
      case '/broken/robots.txt': return respond(500, 'text/plain', 'oops')
      case '/forbidden/robots.txt': return respond(403, 'text/plain', 'no')
      case '/json/robots.txt': return respond(200, 'application/json', '{}')
      default: return respond(404, 'text/plain')
    }
  })
  const fetchRobots = createRobotsFetcher({ validate: allowLoopback })

  assert.deepEqual(await fetchRobots(`${base}/ok/robots.txt`), { status: 'ok', text: 'User-agent: *\nDisallow: /x' })
  assert.deepEqual(await fetchRobots(`${base}/gone/robots.txt`), { status: 'missing' })
  assert.deepEqual(await fetchRobots(`${base}/removed/robots.txt`), { status: 'missing' })
  assert.deepEqual(await fetchRobots(`${base}/broken/robots.txt`), { status: 'error', code: 'HTTP_STATUS' })
  assert.deepEqual(await fetchRobots(`${base}/forbidden/robots.txt`), { status: 'error', code: 'HTTP_STATUS' })
  assert.deepEqual(await fetchRobots(`${base}/json/robots.txt`), { status: 'error', code: 'UNSUPPORTED_CONTENT_TYPE' })
})

test('end to end: an HTML "soft 404" robots.txt means no rules', async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>Page not found</body></html>')
  })
  const { check } = createRobotsChecker({ fetchRobots: createRobotsFetcher({ validate: allowLoopback }) })
  assert.equal((await check(`${base}/page`)).allowed, true)
})

test('the real guard stops robots.txt fetches to private targets', async () => {
  const fetchRobots = createRobotsFetcher() // no injected validator
  assert.deepEqual(await fetchRobots('http://127.0.0.1/robots.txt'), { status: 'error', code: 'IP_BLOCKED' })
})