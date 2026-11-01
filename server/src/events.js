// The event contract between the crawler (server) and the artwork (frontend).
// Every event is one object: { type, crawlId, seq, at, ...payload }.
//
// A discovered link is always tied to its SOURCE page (fromUrl), so the frontend
// can build the real page-link graph.
//
// Payloads:
//   crawl:started      { rootUrl, limits: { maxDepth, maxPages } }
//   page:discovered    { url, fromUrl, depth }                       queued, not fetched yet
//   page:fetched       { url, status, contentType, bytes, title, linkCount, durationMs }
//   link:discovered    { fromUrl, toUrl, text, scope }               scope: 'internal' | 'external'
//   crawler:moved      { fromUrl, toUrl }                            the crawler starts visiting toUrl
//   page:error         { url, code, message }
//   crawl:completed    { pages, links, errors, reason }              reason: 'done' | 'limit' | 'stopped'
//
// Rule: an event is emitted only for something that actually happened.
// page:fetched is never sent for a page that was not fetched.

export const CRAWL_EVENTS = Object.freeze({
  STARTED: 'crawl:started',
  PAGE_DISCOVERED: 'page:discovered',
  PAGE_FETCHED: 'page:fetched',
  LINK_DISCOVERED: 'link:discovered',
  CRAWLER_MOVED: 'crawler:moved',
  PAGE_ERROR: 'page:error',
  COMPLETED: 'crawl:completed',
})

export function createEvent(type, crawlId, seq, payload = {}) {
  return { type, crawlId, seq, at: Date.now(), ...payload }
}