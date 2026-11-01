import { randomUUID } from 'node:crypto'
import { resolveLimits, runCrawl } from './crawler.js'
import { CRAWL_EVENTS, createEvent } from './events.js'
import { validateCrawlTarget } from './urlGuard.js'

// Owns every crawl that is running (or recently finished). It knows nothing about HTTP or
// sockets: transports subscribe with a plain listener function.
//
// Why events are buffered: the client learns the crawl id from the POST response and only
// THEN subscribes. Without a buffer it would miss everything emitted in between.

export class CrawlManagerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CrawlManagerError'
    this.code = code
  }
}

export const CRAWL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BUFFER_SLACK = 500 // trim in batches so we are not shifting a big array on every event

export function createCrawlManager({
  run = runCrawl,
  validate = validateCrawlTarget,
  maxConcurrent = 2,
  retentionMs = 10 * 60 * 1000,
  maxStored = 50,
  bufferLimit = 10_000,
  now = Date.now,
  makeId = randomUUID,
} = {}) {
  const crawls = new Map() // insertion order = oldest first
  let active = 0

  const view = (record) => ({
    crawlId: record.id,
    status: record.status, // running | stopping | finished | stopped | failed
    rootUrl: record.rootUrl,
    limits: record.limits,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    summary: record.summary,
    error: record.error,
  })

  // Called lazily from start()/get(), so no timers are needed.
  function sweep() {
    const time = now()
    for (const [id, record] of crawls) {
      if (record.finishedAt !== null && time - record.finishedAt > retentionMs) crawls.delete(id)
    }
    for (const [id, record] of crawls) {
      if (crawls.size <= maxStored) break
      if (record.finishedAt !== null) crawls.delete(id)
    }
  }

  function record_emit(record, event) {
    record.lastSeq = event.seq
    record.events.push(event)
    if (record.events.length > bufferLimit + BUFFER_SLACK) {
      record.events.splice(0, record.events.length - bufferLimit)
      record.truncated = true
    }
    for (const listener of [...record.listeners]) {
      try {
        listener(event)
      } catch {
        // a broken listener must never affect the crawl or the other listeners
      }
    }
  }

  async function start({ url, limits } = {}) {
    sweep()
    const tooMany = () => new CrawlManagerError('TOO_MANY_CRAWLS', 'Too many crawls are running. Try again shortly.')
    if (active >= maxConcurrent) throw tooMany()

    const target = await validate(url) // throws UrlGuardError before anything starts
    if (active >= maxConcurrent) throw tooMany() // another request may have taken the slot while we awaited

    const id = makeId()
    const controller = new AbortController()
    const record = {
      id,
      status: 'running',
      rootUrl: target.url.href,
      limits: resolveLimits(limits),
      startedAt: now(),
      finishedAt: null,
      summary: null,
      error: null,
      controller,
      events: [],
      truncated: false,
      lastSeq: -1,
      listeners: new Set(),
    }
    crawls.set(id, record)
    active += 1

    Promise.resolve()
      .then(() =>
        run(
          record.rootUrl,
          { limits, emit: (event) => record_emit(record, event), signal: controller.signal },
          { crawlId: id },
        ),
      )
      .then((summary) => {
        record.summary = summary
        record.status = summary.reason === 'stopped' ? 'stopped' : 'finished'
      })
      .catch((error) => {
        record.status = 'failed'
        record.error = { code: error?.code ?? 'UNKNOWN' }
        record_emit(
          record,
          createEvent(CRAWL_EVENTS.COMPLETED, id, record.lastSeq + 1, { pages: 0, links: 0, errors: 1, reason: 'failed' }),
        )
      })
      .finally(() => {
        active -= 1
        record.finishedAt = now()
      })

    return view(record)
  }

  function get(id) {
    sweep()
    const record = crawls.get(id)
    return record ? view(record) : null
  }

  function stop(id) {
    const record = crawls.get(id)
    if (!record) return null
    if (record.status === 'running') {
      record.status = 'stopping'
      record.controller.abort()
    }
    return view(record)
  }

  // Replays buffered events newer than `afterSeq`, then keeps delivering live ones.
  // JavaScript runs this synchronously, so no event can slip between the replay and the live feed.
  function subscribe(id, listener, { afterSeq = -1 } = {}) {
    const record = crawls.get(id)
    if (!record) return null

    const replay = record.events.filter((event) => event.seq > afterSeq)
    const firstBuffered = record.events.length > 0 ? record.events[0].seq : 0
    const gap = record.truncated && afterSeq < firstBuffered - 1

    for (const event of replay) {
      try {
        listener(event)
      } catch {
        // see record_emit
      }
    }
    record.listeners.add(listener)
    return {
      replayed: replay.length,
      gap, // true when the buffer already dropped events this subscriber never saw
      status: record.status,
      unsubscribe: () => record.listeners.delete(listener),
    }
  }

  function shutdown() {
    for (const record of crawls.values()) {
      if (record.status === 'running') {
        record.status = 'stopping'
        record.controller.abort()
      }
    }
  }

  return { start, get, stop, subscribe, shutdown }
}