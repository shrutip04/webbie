import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { validateCrawlTarget } from './urlGuard.js'

// Fetches ONE page safely. Every hop (the first request and each redirect) goes through
// the URL guard again, and the connection is pinned to the addresses the guard approved.

export const FETCH_DEFAULTS = Object.freeze({
  maxBytes: 1_000_000,       // decoded body cap
  timeoutMs: 10_000,         // total budget for the whole fetch, redirects and DNS included
  maxRedirects: 5,
  allowedContentTypes: ['text/html', 'application/xhtml+xml'],
  userAgent: 'WebbieBot/0.1 (+https://github.com/shrutip04/webbie)',
})

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class FetchError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'FetchError'
    this.code = code
    Object.assign(this, details)
  }
}

// Makes the socket connect to an address we already validated, instead of asking DNS again.
// Without this, a hostile DNS server could answer "public" to our check and "private" to the
// real connection (DNS rebinding).
function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    const opts = typeof options === 'object' && options !== null ? options : {}
    const wanted =
      opts.family === 4 || opts.family === 6
        ? addresses.filter((entry) => entry.family === opts.family)
        : addresses
    if (wanted.length === 0) {
      done(Object.assign(new Error('No matching pinned address'), { code: 'ENOTFOUND' }))
      return
    }
    if (opts.all) {
      done(null, wanted.map(({ address, family }) => ({ address, family })))
      return
    }
    done(null, wanted[0].address, wanted[0].family)
  }
}

// Only decompress what we asked for, and count DECODED bytes so a compression bomb cannot slip by.
function decodeStream(res) {
  const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase().trim()
  if (encoding === 'identity' || encoding === '') return res
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(zlib.createGunzip())
  if (encoding === 'deflate') return res.pipe(zlib.createInflate())
  if (encoding === 'br') return res.pipe(zlib.createBrotliDecompress())
  throw new FetchError('UNSUPPORTED_ENCODING', `Unsupported content encoding "${encoding}".`)
}

function decodeBody(buffer, contentType) {
  const match = /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType ?? '')
  const label = match ? match[1] : 'utf-8'
  try {
    return new TextDecoder(label).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

// Rejects with TIMEOUT if `promise` has not settled before `deadline` (a Date.now() timestamp).
function withDeadline(promise, deadline) {
  const ms = deadline - Date.now()
  if (ms <= 0) return Promise.reject(new FetchError('TIMEOUT', 'The request timed out.'))
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FetchError('TIMEOUT', 'The request timed out.')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// One HTTP request, no redirect following. Resolves to { kind: 'redirect' | 'response', ... }.
function requestOnce(url, addresses, { maxBytes, deadline, allowedContentTypes, userAgent }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let req = null

    const timer = setTimeout(
      () => fail(new FetchError('TIMEOUT', 'The request timed out.')),
      Math.max(1, deadline - Date.now()),
    )

    function fail(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req?.destroy()
      reject(error)
    }

    function succeed(value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    function handleResponse(res) {
      const status = res.statusCode ?? 0

      if (REDIRECT_STATUSES.has(status)) {
        succeed({ kind: 'redirect', status, location: res.headers.location })
        req.destroy() // we never need the body of a redirect
        return
      }
      if (status < 200 || status >= 300) {
        fail(new FetchError('HTTP_STATUS', `The server answered with status ${status}.`, { status }))
        return
      }

      const contentType = String(res.headers['content-type'] ?? '')
      const mime = contentType.split(';')[0].trim().toLowerCase()
      if (!allowedContentTypes.includes(mime)) {
        fail(new FetchError('UNSUPPORTED_CONTENT_TYPE', `Content type "${mime || 'unknown'}" is not crawled.`))
        return
      }

      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) {
        fail(new FetchError('RESPONSE_TOO_LARGE', 'The response is larger than the allowed size.'))
        return
      }

      let stream
      try {
        stream = decodeStream(res)
      } catch (error) {
        fail(error)
        return
      }

      const chunks = []
      let total = 0
      stream.on('data', (chunk) => {
        total += chunk.length
        if (total > maxBytes) {
          fail(new FetchError('RESPONSE_TOO_LARGE', 'The response is larger than the allowed size.'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => {
        succeed({ kind: 'response', status, contentType, body: Buffer.concat(chunks) })
      })
      stream.on('error', () => fail(new FetchError('DECODE_ERROR', 'The response body could not be decoded.')))
      res.on('error', () => fail(new FetchError('NETWORK_ERROR', 'The connection failed while reading.')))
      res.on('close', () => {
        if (!res.complete) fail(new FetchError('CONNECTION_LOST', 'The connection closed early.'))
      })
    }

    const transport = url.protocol === 'https:' ? https : http
    req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
        },
        lookup: pinnedLookup(addresses),
        agent: false,        // a fresh connection per request: nothing reused across hosts/addresses
        maxHeaderSize: 16384,
      },
      handleResponse,
    )
    req.on('error', (error) => {
      fail(error instanceof FetchError ? error : new FetchError('NETWORK_ERROR', `Network error (${error.code ?? 'unknown'}).`))
    })
    req.end()
  })
}

// Public API.
// Resolves to { url, status, contentType, bytes, text, redirects, durationMs }.
// Rejects with UrlGuardError (blocked target) or FetchError (everything else).
// `validate` is injectable for tests; production always uses the real guard.
export async function safeFetch(input, options = {}) {
  const { validate = validateCrawlTarget, lookup, ...overrides } = options
  const settings = { ...FETCH_DEFAULTS, ...overrides }
  const startedAt = Date.now()
  const deadline = startedAt + settings.timeoutMs
  const redirects = []

  let current = input
  for (let hop = 0; hop <= settings.maxRedirects; hop++) {
    // The guard runs again on EVERY hop. A redirect to localhost or a metadata address dies here.
    const { url, addresses } = await withDeadline(validate(current, { lookup }), deadline)

    const result = await requestOnce(url, addresses, {
      maxBytes: settings.maxBytes,
      deadline,
      allowedContentTypes: settings.allowedContentTypes,
      userAgent: settings.userAgent,
    })

    if (result.kind === 'redirect') {
      if (!result.location) throw new FetchError('BAD_REDIRECT', 'Redirect without a Location header.')
      let next
      try {
        next = new URL(result.location, url)
      } catch {
        throw new FetchError('BAD_REDIRECT', 'Redirect to an invalid URL.')
      }
      redirects.push(next.href)
      current = next.href
      continue
    }

    return {
      url: url.href,
      status: result.status,
      contentType: result.contentType,
      bytes: result.body.length,
      text: decodeBody(result.body, result.contentType),
      redirects,
      durationMs: Date.now() - startedAt,
    }
  }

  throw new FetchError('TOO_MANY_REDIRECTS', `More than ${settings.maxRedirects} redirects.`)
}