// The event contract between "whatever drives the crawler" and the visuals.
// Today the simulation emits these. Later, Socket.IO handlers will translate
// server events (page:fetched, link:discovered, ...) into the same calls.
export const CRAWL_EVENTS = Object.freeze({
  MOVED: 'crawler:moved',               // { type, targetId }
  LINK_DISCOVERED: 'link:discovered',   // { type, fromId, toId }
})