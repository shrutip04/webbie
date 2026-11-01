import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { io as connect } from 'socket.io-client'
import { createServer } from '../src/app.js'
import { createCrawlManager } from '../src/crawlManager.js'
import { CRAWL_EVENTS, createEvent } from '../src/events.js'
import { validateCrawlTarget } from '../src/urlGuard.js'

const approve = async (input) => ({ url: new URL(input), addresses: [] })
const settle = () => new Promise((resolve) => setImmediate(resolve))

function fakeRun({ hold = false } = {}) {
  return async (rootUrl, { emit, signal }, { crawlId }) => {
    let seq = 0
    const send = (type, payload) => emit(createEvent(type, crawlId, seq++, payload))
    send(CRAWL_EVENTS.STARTED, { rootUrl })
    if (hold) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    else send(CRAWL_EVENTS.PAGE_FETCHED, { url: rootUrl })
    const reason = signal.aborted ? 'stopped' : 'done'
    send(CRAWL_EVENTS.COMPLETED, { pages: 1, links: 0, errors: 0, reason })
    return { crawlId, pages: 1, links: 0, errors: 0, attempts: 1, reason }
  }
}

async function startApp(t, { run = fakeRun(), validate = approve, managerOptions = {}, serverOptions = {} } = {}) {
  const manager = createCrawlManager({ run, validate, ...managerOptions })
  const server = createServer({ manager, ...serverOptions })
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { ...server, manager, base: `http://127.0.0.1:${server.httpServer.address().port}` }
}

// node:http instead of fetch, so tests can set headers like Origin freely.
function request(base, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          // not JSON: leave null
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const postCrawl = (base, payload, headers = {}) =>
  request(base, {
    method: 'POST',
    path: '/crawls',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })

function socketTo(t, base, options = {}) {
  const socket = connect(base, { transports: ['websocket'], reconnection: false, ...options })
  t.after(() => socket.close())
  return socket
}
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve))
const emitAck = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve))

// ---------- HTTP ----------

test('GET /health', async (t) => {
  const app = await startApp(t)
  const res = await request(app.base, { path: '/health' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { ok: true })
  assert.equal(res.headers['x-powered-by'], undefined)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
})

test('POST /crawls starts a crawl and GET /crawls/:id reports it', async (t) => {
  const app = await startApp(t)
  const created = await postCrawl(app.base, { url: 'https://example.com/', maxDepth: 1, maxPages: 3 })
  assert.equal(created.status, 201)
  assert.match(created.json.crawlId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(created.json.limits, { maxDepth: 1, maxPages: 3, delayMs: 1000 })

  const fetched = await request(app.base, { path: `/crawls/${created.json.crawlId}` })
  assert.equal(fetched.status, 200)
  assert.equal(fetched.json.crawlId, created.json.crawlId)
})

test('rejects malformed, non-object and non-JSON bodies', async (t) => {
  const app = await startApp(t)
  const badJson = await postCrawl(app.base, '{"url":')
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.error.code, 'BAD_JSON')

  const array = await postCrawl(app.base, '[1,2]')
  assert.equal(array.status, 400)
  assert.equal(array.json.error.code, 'INVALID_BODY')

  const text = await request(app.base, { method: 'POST', path: '/crawls', headers: { 'content-type': 'text/plain' }, body: 'hello' })
  assert.equal(text.status, 400)
})

test('rejects a missing url and non-numeric limits', async (t) => {
  const app = await startApp(t)
  const noUrl = await postCrawl(app.base, {})
  assert.equal(noUrl.status, 400)
  assert.equal(noUrl.json.error.code, 'INVALID_URL')

  const badLimit = await postCrawl(app.base, { url: 'https://example.com/', maxPages: 'lots' })
  assert.equal(badLimit.status, 400)
  assert.equal(badLimit.json.error.code, 'INVALID_LIMITS')
})

test('the real URL guard turns blocked targets into 400s', async (t) => {
  const app = await startApp(t, { validate: validateCrawlTarget })
  const cases = [
    ['http://127.0.0.1/', 'IP_BLOCKED'],
    ['http://169.254.169.254/latest/meta-data/', 'IP_BLOCKED'],
    ['http://localhost/', 'HOST_BLOCKED'],
    ['ftp://example.com/', 'UNSUPPORTED_PROTOCOL'],
  ]
  for (const [url, code] of cases) {
    const res = await postCrawl(app.base, { url })
    assert.equal(res.status, 400, url)
    assert.equal(res.json.error.code, code, url)
  }
})

test('oversized bodies are refused', async (t) => {
  const app = await startApp(t)
  const res = await postCrawl(app.base, `{"url":"https://example.com/","pad":"${'a'.repeat(5000)}"}`)
  assert.equal(res.status, 413)
  assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE')
})

test('requests from disallowed origins are refused, allowed ones get CORS headers', async (t) => {
  const app = await startApp(t)
  const evil = await postCrawl(app.base, { url: 'https://example.com/' }, { origin: 'http://evil.test' })
  assert.equal(evil.status, 403)
  assert.equal(evil.json.error.code, 'ORIGIN_NOT_ALLOWED')

  const good = await request(app.base, { path: '/health', headers: { origin: 'http://localhost:5173' } })
  assert.equal(good.status, 200)
  assert.equal(good.headers['access-control-allow-origin'], 'http://localhost:5173')

  const preflight = await request(app.base, { method: 'OPTIONS', path: '/crawls', headers: { origin: 'http://localhost:5173' } })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers['access-control-allow-methods'], /POST/)
})

test('POST /crawls is rate limited per client', async (t) => {
  const app = await startApp(t, { serverOptions: { rateLimit: { windowMs: 60_000, max: 2 } } })
  assert.equal((await postCrawl(app.base, { url: 'https://example.com/' })).status, 201)
  assert.equal((await postCrawl(app.base, { url: 'https://example.com/' })).status, 201)
  const third = await postCrawl(app.base, { url: 'https://example.com/' })
  assert.equal(third.status, 429)
  assert.equal(third.json.error.code, 'RATE_LIMITED')
})

test('too many simultaneous crawls give 429', async (t) => {
  const app = await startApp(t, { run: fakeRun({ hold: true }), managerOptions: { maxConcurrent: 1 } })
  assert.equal((await postCrawl(app.base, { url: 'https://example.com/' })).status, 201)
  const second = await postCrawl(app.base, { url: 'https://example.org/' })
  assert.equal(second.status, 429)
  assert.equal(second.json.error.code, 'TOO_MANY_CRAWLS')
})

test('GET and DELETE handle unknown ids, bad ids and running crawls', async (t) => {
  const app = await startApp(t, { run: fakeRun({ hold: true }) })
  assert.equal((await request(app.base, { path: '/crawls/not-a-uuid' })).status, 404)
  assert.equal((await request(app.base, { path: '/crawls/00000000-0000-4000-8000-000000000000' })).status, 404)
  assert.equal((await request(app.base, { method: 'DELETE', path: '/crawls/nope' })).status, 404)

  const { json } = await postCrawl(app.base, { url: 'https://example.com/' })
  const stopped = await request(app.base, { method: 'DELETE', path: `/crawls/${json.crawlId}` })
  assert.equal(stopped.status, 202)
  assert.equal(stopped.json.status, 'stopping')
})

test('unknown routes return a JSON 404', async (t) => {
  const app = await startApp(t)
  const res = await request(app.base, { path: '/nope' })
  assert.equal(res.status, 404)
  assert.equal(res.json.error.code, 'NOT_FOUND')
})

// ---------- Socket.IO ----------

test('socket: subscribing replays a finished crawl in order', { timeout: 5000 }, async (t) => {
  const app = await startApp(t)
  const { crawlId } = await app.manager.start({ url: 'https://example.com/' })
  await settle()

  const socket = socketTo(t, app.base)
  await once(socket, 'connect')
  const received = []
  socket.onAny((name) => received.push(name))

  const ack = await emitAck(socket, 'subscribe', { crawlId })
  assert.deepEqual(received, ['crawl:started', 'page:fetched', 'crawl:completed'])
  assert.deepEqual(ack, { ok: true, replayed: 3, gap: false, status: 'finished' })
})

test('socket: afterSeq skips events the client already has', { timeout: 5000 }, async (t) => {
  const app = await startApp(t)
  const { crawlId } = await app.manager.start({ url: 'https://example.com/' })
  await settle()

  const socket = socketTo(t, app.base)
  await once(socket, 'connect')
  const received = []
  socket.onAny((name) => received.push(name))
  await emitAck(socket, 'subscribe', { crawlId, afterSeq: 1 })
  assert.deepEqual(received, ['crawl:completed'])
})

test('socket: live events arrive after subscribing', { timeout: 5000 }, async (t) => {
  const app = await startApp(t, { run: fakeRun({ hold: true }) })
  const { crawlId } = await app.manager.start({ url: 'https://example.com/' })

  const socket = socketTo(t, app.base)
  await once(socket, 'connect')
  const ack = await emitAck(socket, 'subscribe', { crawlId })
  assert.equal(ack.ok, true)

  const completed = once(socket, 'crawl:completed')
  app.manager.stop(crawlId)
  const event = await completed
  assert.equal(event.reason, 'stopped')
  assert.equal(event.crawlId, crawlId)
})

test('socket: bad subscribe requests get a clear error', { timeout: 5000 }, async (t) => {
  const app = await startApp(t, { run: fakeRun({ hold: true }) })
  const { crawlId } = await app.manager.start({ url: 'https://example.com/' })
  const socket = socketTo(t, app.base)
  await once(socket, 'connect')

  assert.deepEqual(await emitAck(socket, 'subscribe', null), { ok: false, error: 'INVALID_CRAWL_ID' })
  assert.deepEqual(await emitAck(socket, 'subscribe', { crawlId: 'nope' }), { ok: false, error: 'INVALID_CRAWL_ID' })
  assert.deepEqual(await emitAck(socket, 'subscribe', { crawlId, afterSeq: 'x' }), { ok: false, error: 'INVALID_AFTER_SEQ' })
  assert.deepEqual(
    await emitAck(socket, 'subscribe', { crawlId: '00000000-0000-4000-8000-000000000000' }),
    { ok: false, error: 'CRAWL_NOT_FOUND' },
  )
  assert.equal((await emitAck(socket, 'subscribe', { crawlId })).ok, true)
  assert.deepEqual(await emitAck(socket, 'subscribe', { crawlId }), { ok: false, error: 'ALREADY_SUBSCRIBED' })
})

test('socket: connections from disallowed origins are refused', { timeout: 5000 }, async (t) => {
  const app = await startApp(t)
  const bad = socketTo(t, app.base, { extraHeaders: { Origin: 'http://evil.test' } })
  assert.ok(await once(bad, 'connect_error'))

  const good = socketTo(t, app.base, { extraHeaders: { Origin: 'http://localhost:5173' } })
  await once(good, 'connect')
})