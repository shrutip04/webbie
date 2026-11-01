import { safeFetch, FetchError } from './safeFetch.js'

// Reads and obeys robots.txt (RFC 9309 rules). Core rule of this file: when in doubt, don't crawl.
//
//   rules found            -> follow them (longest matching rule wins, Allow wins ties)
//   robots.txt is 404/410  -> the site has no rules: crawling is allowed
//   anything else wrong    -> treat as "disallow everything" for a short while
//                             (5xx, 401/403/429, timeout, too large, blocked redirect, ...)

// Must match the product token in the User-Agent we send (see FETCH_DEFAULTS.userAgent: "WebbieBot/0.1").
export const ROBOTS_TOKEN = 'webbiebot'

const MAX_PATTERN_LENGTH = 512
const FAILURE_TTL_MS = 5 * 60 * 1000
const MAX_CACHED_ORIGINS = 500

const ROBOTS_FETCH_OPTIONS = Object.freeze({
  maxBytes: 512_000,       // 500 KiB, the size crawlers are expected to handle
  timeoutMs: 8_000,
  maxRedirects: 5,
  // Many sites answer a missing robots.txt with an HTML page and status 200. We accept
  // that and simply find no rules in it.
  allowedContentTypes: ['text/plain', 'text/html'],
})

// ---------- pattern matching ----------

// Glob match where only '*' is special. Two-pointer algorithm: no regex, so a hostile
// pattern such as "/*a*a*a*a*b" cannot cause catastrophic backtracking.
function globMatch(pattern, text) {
  let p = 0
  let t = 0
  let starP = -1
  let starT = 0
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      starP = p++
      starT = t
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++
      t++
    } else if (starP !== -1) {
      p = starP + 1
      t = ++starT
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

// robots patterns are PREFIX matches. '*' matches anything, a trailing '$' means "ends here".
function ruleMatches(pattern, target) {
  const anchored = pattern.endsWith('$')
  const core = anchored ? pattern.slice(0, -1) : pattern
  return globMatch(anchored ? core : `${core}*`, target)
}

// ---------- parsing ----------

export function parseRobots(text, { userAgentToken = ROBOTS_TOKEN } = {}) {
  const token = userAgentToken.toLowerCase()
  const groups = [] // { agents: string[], rules: { allow, pattern }[], crawlDelay: number | null }
  let current = null
  let collectingAgents = false

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.split('#')[0].trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()

    if (field === 'user-agent') {
      // Consecutive user-agent lines share one group. A user-agent line after rules starts a new group.
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [], crawlDelay: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      collectingAgents = true
      continue
    }

    if (!current) continue // a rule before any user-agent line belongs to no group
    collectingAgents = false

    if (field === 'allow' || field === 'disallow') {
      if (value === '') continue // "Disallow:" with no value blocks nothing
      const looksValid = value.startsWith('/') || value.startsWith('*')
      if (!looksValid || value.length > MAX_PATTERN_LENGTH) continue
      current.rules.push({ allow: field === 'allow', pattern: value })
    } else if (field === 'crawl-delay') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds
    }
  }

  // A group naming us beats the '*' group. Several groups for the same agent are merged.
  const specific = groups.filter((group) => group.agents.includes(token))
  const matched = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes('*'))

  const delays = matched.map((group) => group.crawlDelay).filter((delay) => delay !== null)
  return {
    rules: matched.flatMap((group) => group.rules),
    crawlDelayMs: delays.length > 0 ? Math.max(...delays) * 1000 : null,
  }
}

// `target` is the path plus the query string, e.g. "/search?q=cats".
export function isPathAllowed(rules, target) {
  let best = null
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, target)) continue
    const longer = best === null || rule.pattern.length > best.pattern.length
    const tieGoesToAllow = best !== null && rule.pattern.length === best.pattern.length && rule.allow && !best.allow
    if (longer || tieGoesToAllow) best = rule
  }
  return best === null ? true : best.allow
}

// ---------- fetching ----------

// Turns the many ways a fetch can end into three outcomes the policy understands:
//   { status: 'ok', text } | { status: 'missing' } | { status: 'error', code }
// `safeFetchOptions` exists so tests can inject a validator; production passes nothing.
export function createRobotsFetcher(safeFetchOptions = {}) {
  return async function fetchRobots(robotsUrl) {
    try {
      const result = await safeFetch(robotsUrl, { ...ROBOTS_FETCH_OPTIONS, ...safeFetchOptions })
      return { status: 'ok', text: result.text }
    } catch (error) {
      const isGone = error instanceof FetchError && error.code === 'HTTP_STATUS' && (error.status === 404 || error.status === 410)
      if (isGone) return { status: 'missing' }
      return { status: 'error', code: error.code ?? 'UNKNOWN' }
    }
  }
}

// ---------- the checker the crawler will use ----------

// check(url) -> { allowed, crawlDelayMs, reason }
//   reason: 'allowed' | 'blocked-by-rule' | 'robots-unavailable' | 'robots-error' | 'robots-file'
// Policies are cached per origin (scheme + host + port) and concurrent checks share one fetch.
export function createRobotsChecker({
  fetchRobots = createRobotsFetcher(),
  userAgentToken = ROBOTS_TOKEN,
  ttlMs = 60 * 60 * 1000,
  now = Date.now,
} = {}) {
  const cache = new Map()

  async function load(origin) {
    let outcome
    try {
      outcome = await fetchRobots(`${origin}/robots.txt`)
    } catch {
      outcome = { status: 'error', code: 'UNKNOWN' }
    }
    if (outcome.status === 'ok') {
      return { mode: 'rules', ...parseRobots(outcome.text, { userAgentToken }), ttl: ttlMs }
    }
    if (outcome.status === 'missing') {
      return { mode: 'allow-all', rules: [], crawlDelayMs: null, ttl: ttlMs }
    }
    // Failures are remembered only briefly, so a hiccup does not block a site for an hour.
    return { mode: 'disallow-all', rules: [], crawlDelayMs: null, ttl: Math.min(ttlMs, FAILURE_TTL_MS) }
  }

  function policyFor(origin) {
    const cached = cache.get(origin)
    if (cached && cached.expiresAt > now()) return cached.promise

    if (cache.size >= MAX_CACHED_ORIGINS) cache.delete(cache.keys().next().value)
    const entry = { expiresAt: Infinity, promise: null } // never "expired" while the fetch is in flight
    entry.promise = load(origin).then((policy) => {
      entry.expiresAt = now() + policy.ttl
      return policy
    })
    cache.set(origin, entry)
    return entry.promise
  }

  async function check(input) {
    const url = input instanceof URL ? input : new URL(input)
    if (url.pathname === '/robots.txt') {
      return { allowed: true, crawlDelayMs: null, reason: 'robots-file' }
    }

    const policy = await policyFor(url.origin)
    if (policy.mode === 'disallow-all') return { allowed: false, crawlDelayMs: null, reason: 'robots-error' }
    if (policy.mode === 'allow-all') return { allowed: true, crawlDelayMs: null, reason: 'robots-unavailable' }

    const allowed = isPathAllowed(policy.rules, `${url.pathname}${url.search}`)
    return { allowed, crawlDelayMs: policy.crawlDelayMs, reason: allowed ? 'allowed' : 'blocked-by-rule' }
  }

  return { check }
}