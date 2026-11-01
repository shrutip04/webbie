import { randomUUID } from 'node:crypto'
import { CRAWL_EVENTS, createEvent } from './events.js'
import { UrlGuardError, parseCrawlUrl, validateCrawlTarget } from './urlGuard.js'
import { FetchError, safeFetch } from './safeFetch.js'
import { createRobotsChecker } from './robots.js'
import { extractLinks, hostKey, normalizeUrl } from './extract.js'

// The crawl loop. It owns no network code of its own: every request goes through
// safeFetch (guard, pinning, limits) and robots.txt is consulted first.
//
// Rules of this file:
//  - one request at a time, so per-host concurrency is 1
//  - breadth-first, internal links only (same host as the root, ignoring "www.")
//  - hard limits on depth and page count that callers cannot raise past the ceilings
//  - an event is emitted only for something that really happened

export const LIMIT_DEFAULTS = Object.freeze({ maxDepth: 2, maxPages: 20, delayMs: 1000 })
export const LIMIT_CEILINGS = Object.freeze({ maxDepth: 5, maxPages: 100, delayMs: 30_000 })
export const MIN_DELAY_MS = 500           // politeness floor
const MAX_CRAWL_DELAY_MS = 30_000         // a site asking for more than this is skipped, not obeyed forever

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const wholeNumber = (value, fallback) => (Number.isFinite(value) ? Math.floor(value) : fallback)

// Anything missing, non-numeric or out of range is pulled back into safe bounds.
export function resolveLimits(input = {}) {
  return {
    maxDepth: clamp(wholeNumber(input.maxDepth, LIMIT_DEFAULTS.maxDepth), 0, LIMIT_CEILINGS.maxDepth),
    maxPages: clamp(wholeNumber(input.maxPages, LIMIT_DEFAULTS.maxPages), 1, LIMIT_CEILINGS.maxPages),
    delayMs: clamp(wholeNumber(input.delayMs, LIMIT_DEFAULTS.delayMs), MIN_DELAY_MS, LIMIT_CEILINGS.delayMs),
  }
}

// Resolves after `ms`, or immediately when the signal aborts.
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// Only our own errors carry messages that are safe to show; everything else is generic.
function describeError(error) {
  if (error instanceof UrlGuardError || error instanceof FetchError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'UNKNOWN', message: 'Unexpected error.' }
}

// runCrawl(rootUrl, { limits, emit, signal }, deps)
//   Throws UrlGuardError BEFORE emitting anything if the root URL is not allowed.
//   Otherwise resolves to { crawlId, pages, links, errors, attempts, reason }.
//   `deps` exists so tests can run without a network or real waiting.
export async function runCrawl(rootUrl, options = {}, deps = {}) {
  const root = parseCrawlUrl(rootUrl)
  const limits = resolveLimits(options.limits)
  const { emit = () => {}, signal } = options
  const {
    fetchPage = safeFetch,
    robots = createRobotsChecker(),
    sleep = defaultSleep,
    now = Date.now,
    crawlId = randomUUID(),
  } = deps

  let seq = 0
  const send = (type, payload) => {
    try {
      emit(createEvent(type, crawlId, seq++, payload))
    } catch {
      // a broken listener must never stop the crawl
    }
  }

  const rootKey = normalizeUrl(root)
  const rootHostKey = hostKey(root.hostname)

  const queue = [{ url: rootKey, fromUrl: null, depth: 0 }]
  let head = 0
  const seen = new Set([rootKey])     // queued or visited: never queued twice
  const visited = new Set()           // pages actually fetched (by their final URL)
  const nextAllowedAt = new Map()     // hostname -> earliest time of the next request

  let attempts = 0
  let pages = 0
  let links = 0
  let errors = 0
  let hitLimit = false

  const reportError = (url, code, message) => {
    errors += 1
    send(CRAWL_EVENTS.PAGE_ERROR, { url, code, message })
  }

  // Used for every hop inside safeFetch, so a redirect cannot lead to a page robots.txt forbids.
  const validateWithRobots = async (input, validateOptions) => {
    const target = await validateCrawlTarget(input, validateOptions)
    const verdict = await robots.check(target.url)
    if (!verdict.allowed) throw new FetchError('ROBOTS_DISALLOWED', 'Blocked by robots.txt.')
    return target
  }

  send(CRAWL_EVENTS.STARTED, { rootUrl: rootKey, limits: { maxDepth: limits.maxDepth, maxPages: limits.maxPages } })
  send(CRAWL_EVENTS.PAGE_DISCOVERED, { url: rootKey, fromUrl: null, depth: 0 })

  while (head < queue.length && !signal?.aborted) {
    if (attempts >= limits.maxPages) {
      hitLimit = true
      break
    }
    const entry = queue[head++]
    const host = new URL(entry.url).hostname

    // 1. robots.txt (cached per site). Also tells us how long to wait between requests.
    let verdict
    try {
      verdict = await robots.check(new URL(entry.url))
    } catch {
      verdict = { allowed: false, crawlDelayMs: null }
    }
    if (signal?.aborted) break
    if (!verdict.allowed) {
      reportError(entry.url, 'ROBOTS_DISALLOWED', 'Blocked by robots.txt.')
      continue
    }
    if (verdict.crawlDelayMs !== null && verdict.crawlDelayMs > MAX_CRAWL_DELAY_MS) {
      reportError(entry.url, 'ROBOTS_CRAWL_DELAY_TOO_LONG', 'The site asks for a longer delay than this crawler allows.')
      continue
    }
    const delayMs = Math.max(limits.delayMs, verdict.crawlDelayMs ?? 0)

    // 2. politeness: never hit the same host faster than the delay allows
    const waitMs = (nextAllowedAt.get(host) ?? 0) - now()
    if (waitMs > 0) await sleep(waitMs, signal)
    if (signal?.aborted) break

    // 3. fetch
    attempts += 1
    send(CRAWL_EVENTS.CRAWLER_MOVED, { fromUrl: entry.fromUrl, toUrl: entry.url })

    let page
    try {
      page = await fetchPage(entry.url, { validate: validateWithRobots })
    } catch (error) {
      nextAllowedAt.set(host, now() + delayMs)
      const { code, message } = describeError(error)
      reportError(entry.url, code, message)
      continue
    }
    nextAllowedAt.set(host, now() + delayMs)

    // 4. the final URL (after redirects) must be in scope and not already crawled
    let finalUrl
    try {
      finalUrl = normalizeUrl(page.url)
    } catch {
      reportError(entry.url, 'UNKNOWN', 'Unexpected error.')
      continue
    }
    if (hostKey(new URL(finalUrl).hostname) !== rootHostKey) {
      reportError(entry.url, 'REDIRECTED_OUT_OF_SCOPE', 'Redirected outside the crawl scope.')
      continue
    }
    if (visited.has(finalUrl)) {
      reportError(entry.url, 'DUPLICATE_PAGE', 'This page was already crawled (reached through a redirect).')
      continue
    }
    visited.add(finalUrl)
    seen.add(finalUrl)
    pages += 1

    // 5. extract links and report them, tied to the page they were found on
    const extracted = extractLinks(page.text, finalUrl, { rootHost: root.hostname })
    if (extracted.truncated) hitLimit = true

    send(CRAWL_EVENTS.PAGE_FETCHED, {
      url: finalUrl,
      status: page.status,
      contentType: page.contentType,
      bytes: page.bytes,
      title: extracted.title,
      linkCount: extracted.links.length,
      durationMs: page.durationMs,
    })

    for (const link of extracted.links) {
      links += 1
      send(CRAWL_EVENTS.LINK_DISCOVERED, { fromUrl: finalUrl, toUrl: link.url, text: link.text, scope: link.scope })

      if (!link.follow || link.scope !== 'internal') continue // reported, but never visited
      if (seen.has(link.url)) continue
      if (entry.depth + 1 > limits.maxDepth) {
        hitLimit = true
        continue
      }
      const pending = queue.length - head
      if (attempts + pending >= limits.maxPages) {
        hitLimit = true // no point queueing pages the page limit would never reach
        continue
      }
      seen.add(link.url)
      queue.push({ url: link.url, fromUrl: finalUrl, depth: entry.depth + 1 })
      send(CRAWL_EVENTS.PAGE_DISCOVERED, { url: link.url, fromUrl: finalUrl, depth: entry.depth + 1 })
    }
  }

  let reason = 'done'
  if (signal?.aborted) reason = 'stopped'
  else if (hitLimit || head < queue.length) reason = 'limit'

  send(CRAWL_EVENTS.COMPLETED, { pages, links, errors, reason })
  return { crawlId, pages, links, errors, attempts, reason }
}