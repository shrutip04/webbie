import http from 'node:http'
import express from 'express'
import { Server as SocketServer } from 'socket.io'
import { CRAWL_ID_PATTERN, CrawlManagerError } from './crawlManager.js'
import { UrlGuardError } from './urlGuard.js'

// HTTP + Socket.IO front door. All crawling rules live elsewhere; this file only
// validates requests, limits abuse and moves events to the browser.
//
// The server is meant to run on localhost for your own frontend. It is NOT safe to expose
// publicly as-is: anyone who can reach it can make your machine fetch URLs.

export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']
const LIMIT_KEYS = ['maxDepth', 'maxPages', 'delayMs']
const MAX_SUBSCRIPTIONS_PER_SOCKET = 3
const MAX_TRACKED_CLIENTS = 1000

const sendError = (res, status, code, message) => res.status(status).json({ error: { code, message } })

// Fixed-window counter per client. Plenty for a local tool; swap for a real limiter if this ever goes public.
function createRateLimiter({ windowMs, max, now }) {
  const clients = new Map()
  return function allow(key) {
    const time = now()
    if (clients.size > MAX_TRACKED_CLIENTS) {
      for (const [k, entry] of clients) if (time - entry.start >= windowMs) clients.delete(k)
    }
    const entry = clients.get(key)
    if (!entry || time - entry.start >= windowMs) {
      clients.set(key, { start: time, count: 1 })
      return true
    }
    entry.count += 1
    return entry.count <= max
  }
}

export function createServer({
  manager,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  rateLimit = { windowMs: 60_000, max: 10 },
  now = Date.now,
} = {}) {
  const origins = new Set(allowedOrigins)
  const allowCrawlRequest = createRateLimiter({ ...rateLimit, now })

  const app = express()
  app.disable('x-powered-by')

  // Origin check + CORS. Browsers always send Origin on cross-origin requests; tools like curl send none.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')

    const origin = req.headers.origin
    if (origin !== undefined) {
      if (!origins.has(origin)) return sendError(res, 403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.')
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Max-Age', '600')
      return res.status(204).end()
    }
    return next()
  })

  app.get('/health', (req, res) => res.json({ ok: true }))

  app.post(
    '/crawls',
    (req, res, next) => {
      const client = req.socket.remoteAddress ?? 'unknown'
      if (!allowCrawlRequest(client)) return sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.')
      return next()
    },
    express.json({ limit: '2kb' }),
    async (req, res, next) => {
      try {
        const body = req.body
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return sendError(res, 400, 'INVALID_BODY', 'Send a JSON object with Content-Type: application/json.')
        }
        if (typeof body.url !== 'string') return sendError(res, 400, 'INVALID_URL', '"url" must be a string.')

        const limits = {}
        for (const key of LIMIT_KEYS) {
          if (body[key] === undefined) continue
          if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
            return sendError(res, 400, 'INVALID_LIMITS', `"${key}" must be a number.`)
          }
          limits[key] = body[key] // the crawler clamps these into safe bounds
        }

        const crawl = await manager.start({ url: body.url, limits })
        return res.status(201).json(crawl)
      } catch (error) {
        return next(error)
      }
    },
  )

  app.get('/crawls/:id', (req, res) => {
    const crawl = CRAWL_ID_PATTERN.test(req.params.id) ? manager.get(req.params.id) : null
    if (!crawl) return sendError(res, 404, 'NOT_FOUND', 'No such crawl.')
    return res.json(crawl)
  })

  app.delete('/crawls/:id', (req, res) => {
    const crawl = CRAWL_ID_PATTERN.test(req.params.id) ? manager.stop(req.params.id) : null
    if (!crawl) return sendError(res, 404, 'NOT_FOUND', 'No such crawl.')
    return res.status(202).json(crawl)
  })

  app.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'No such route.'))

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof UrlGuardError) return sendError(res, 400, error.code, error.message)
    if (error instanceof CrawlManagerError) {
      return sendError(res, error.code === 'TOO_MANY_CRAWLS' ? 429 : 400, error.code, error.message)
    }
    if (error?.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.')
    if (error?.type === 'entity.parse.failed' || error?.status === 400) {
      return sendError(res, 400, 'BAD_JSON', 'The request body is not valid JSON.')
    }
    if (res.headersSent) return undefined
    console.error('Unhandled error:', error) // details stay in the server log, never in the response
    return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong.')
  })

  const httpServer = http.createServer(app)
  const io = new SocketServer(httpServer, {
    serveClient: false,
    maxHttpBufferSize: 10_000,
    cors: { origin: [...origins], methods: ['GET', 'POST'] },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin
      callback(null, origin === undefined || origins.has(origin))
    },
  })

  // Socket protocol:
  //   client -> server  'subscribe'   { crawlId, afterSeq? }  with an ack: { ok, replayed, gap, status } | { ok: false, error }
  //   client -> server  'unsubscribe' { crawlId }
  //   server -> client  one message per crawl event, named after event.type (e.g. 'page:fetched')
  io.on('connection', (socket) => {
    const subscriptions = new Map()

    socket.on('subscribe', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {}
      const crawlId = payload?.crawlId
      const afterSeq = payload?.afterSeq ?? -1

      if (typeof crawlId !== 'string' || !CRAWL_ID_PATTERN.test(crawlId)) return reply({ ok: false, error: 'INVALID_CRAWL_ID' })
      if (!Number.isInteger(afterSeq) || afterSeq < -1) return reply({ ok: false, error: 'INVALID_AFTER_SEQ' })
      if (subscriptions.has(crawlId)) return reply({ ok: false, error: 'ALREADY_SUBSCRIBED' })
      if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) return reply({ ok: false, error: 'TOO_MANY_SUBSCRIPTIONS' })

      const subscription = manager.subscribe(crawlId, (event) => socket.emit(event.type, event), { afterSeq })
      if (!subscription) return reply({ ok: false, error: 'CRAWL_NOT_FOUND' })

      subscriptions.set(crawlId, subscription)
      return reply({ ok: true, replayed: subscription.replayed, gap: subscription.gap, status: subscription.status })
    })

    socket.on('unsubscribe', (payload) => {
      const subscription = subscriptions.get(payload?.crawlId)
      if (!subscription) return
      subscription.unsubscribe()
      subscriptions.delete(payload.crawlId)
    })

    socket.on('disconnect', () => {
      for (const subscription of subscriptions.values()) subscription.unsubscribe()
      subscriptions.clear()
    })
  })

  function close() {
    manager.shutdown()
    return new Promise((resolve) => {
      io.close(() => resolve()) // also closes the underlying HTTP server
      httpServer.closeAllConnections?.()
    })
  }

  return { app, httpServer, io, close }
}