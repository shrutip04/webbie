import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { safeFetch, FetchError } from '../src/safeFetch.js'
import { UrlGuardError } from '../src/urlGuard.js'

const isFetchError = (code) => (error) => error instanceof FetchError && error.code === code
const isGuardError = (code) => (error) => error instanceof UrlGuardError && error.code === code

// Tests talk to a local server, which the real guard would (correctly) refuse.
// So tests inject a validator that approves loopback. Production always uses the real guard.
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

const sendHtml = (res, body = '<html><title>hi</title></html>') => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

test('fetches an HTML page', async (t) => {
  const base = await startServer(t, (req, res) => sendHtml(res))
  const result = await safeFetch(`${base}/`, { validate: allowLoopback })
  assert.equal(result.status, 200)
  assert.match(result.contentType, /text\/html/)
  assert.ok(result.text.includes('<title>hi</title>'))
  assert.deepEqual(result.redirects, [])
})

test('connects to the validated address, not whatever DNS says (pinning)', async (t) => {
  let seenHost = null
  const base = await startServer(t, (req, res) => {
    seenHost = req.headers.host
    sendHtml(res)
  })
  // "pinned.test" does not exist in DNS. This only works if we connect to the pinned 127.0.0.1.
  const url = base.replace('localhost', 'pinned.test')
  const result = await safeFetch(`${url}/`, { validate: allowLoopback })
  assert.equal(result.status, 200)
  assert.equal(seenHost, new URL(url).host)
})

test('decodes gzip responses', async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
    res.end(zlib.gzipSync('<html>zipped</html>'))
  })
  const result = await safeFetch(`${base}/`, { validate: allowLoopback })
  assert.equal(result.text, '<html>zipped</html>')
})

test('decodes the declared charset', async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' })
    res.end(Buffer.from('café', 'latin1'))
  })
  const result = await safeFetch(`${base}/`, { validate: allowLoopback })
  assert.equal(result.text, 'café')
})

test('refuses content that is not HTML', async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await assert.rejects(safeFetch(`${base}/`, { validate: allowLoopback }), isFetchError('UNSUPPORTED_CONTENT_TYPE'))
})

test('reports non-2xx statuses as errors with the status code', async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('nope')
  })
  await assert.rejects(safeFetch(`${base}/`, { validate: allowLoopback }), (error) => {
    return error instanceof FetchError && error.code === 'HTTP_STATUS' && error.status === 404
  })
})

test('stops reading a streamed body that exceeds the size limit', async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }) // no content-length: chunked
    res.write(Buffer.alloc(600, 'a'))
    res.write(Buffer.alloc(600, 'a'))
    res.write(Buffer.alloc(600, 'a'))
    res.end()
  })
  await assert.rejects(
    safeFetch(`${base}/`, { validate: allowLoopback, maxBytes: 1000 }),
    isFetchError('RESPONSE_TOO_LARGE'),
  )
})

test('rejects early when content-length already exceeds the limit', async (t) => {
  const base = await startServer(t, (req, res) => sendHtml(res, 'x'.repeat(5000)))
  await assert.rejects(
    safeFetch(`${base}/`, { validate: allowLoopback, maxBytes: 1000 }),
    isFetchError('RESPONSE_TOO_LARGE'),
  )
})

test('times out when the server never answers', async (t) => {
  const base = await startServer(t, () => {})
  await assert.rejects(
    safeFetch(`${base}/`, { validate: allowLoopback, timeoutMs: 200 }),
    isFetchError('TIMEOUT'),
  )
})

test('follows a relative redirect and records it', async (t) => {
  const base = await startServer(t, (req, res) => {
    if (req.url === '/a') {
      res.writeHead(302, { location: '/b' })
      res.end()
      return
    }
    sendHtml(res, '<html>final</html>')
  })
  const result = await safeFetch(`${base}/a`, { validate: allowLoopback })
  assert.equal(result.url, `${base}/b`)
  assert.deepEqual(result.redirects, [`${base}/b`])
  assert.equal(result.text, '<html>final</html>')
})

test('re-validates every hop and refuses a redirect to a blocked target', async (t) => {
  const calls = []
  const validate = async (input) => {
    calls.push(input)
    if (new URL(input).hostname === 'internal.test') {
      throw new UrlGuardError('IP_BLOCKED', 'blocked')
    }
    return allowLoopback(input)
  }
  const base = await startServer(t, (req, res) => {
    res.writeHead(302, { location: 'http://internal.test/admin' })
    res.end()
  })
  await assert.rejects(safeFetch(`${base}/`, { validate }), isGuardError('IP_BLOCKED'))
  assert.equal(calls.length, 2) // the first URL, then the redirect target
})

test('gives up on redirect loops', async (t) => {
  let hits = 0
  const base = await startServer(t, (req, res) => {
    hits += 1
    res.writeHead(302, { location: '/loop' })
    res.end()
  })
  await assert.rejects(
    safeFetch(`${base}/loop`, { validate: allowLoopback, maxRedirects: 3 }),
    isFetchError('TOO_MANY_REDIRECTS'),
  )
  assert.equal(hits, 4) // the first request plus three followed redirects
})

test('rejects a redirect without a Location header', async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(302)
    res.end()
  })
  await assert.rejects(safeFetch(`${base}/`, { validate: allowLoopback }), isFetchError('BAD_REDIRECT'))
})

test('the real guard refuses private targets before any connection is made', async () => {
  await assert.rejects(safeFetch('http://127.0.0.1/'), isGuardError('IP_BLOCKED'))
  await assert.rejects(safeFetch('http://169.254.169.254/latest/meta-data/'), isGuardError('IP_BLOCKED'))
  await assert.rejects(safeFetch('http://localhost/'), isGuardError('HOST_BLOCKED'))
})