import * as cheerio from 'cheerio'

// Turns fetched HTML into a list of clean, deduplicated links.
// Cheerio only PARSES. It never runs scripts, loads images or follows anything.

const MAX_LINKS_PER_PAGE = 200
const MAX_TEXT_LENGTH = 100
const MAX_TITLE_LENGTH = 200

// Links to files are not crawled (safeFetch refuses non-HTML anyway, this just avoids wasted requests).
const SKIPPED_EXTENSIONS = new Set([
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'exe', 'dmg', 'iso', 'msi', 'apk',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'webm', 'wav', 'flac',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tif', 'tiff',
  'css', 'js', 'json', 'xml', 'woff', 'woff2', 'ttf', 'otf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
])

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'yclid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi',
])

function isTrackingParam(name) {
  const lower = name.toLowerCase()
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)
}

const collapseWhitespace = (text) => text.replace(/\s+/g, ' ').trim()

// One canonical spelling per page, so the queue can tell "same page" at a glance:
// fragment removed, tracking parameters removed, remaining parameters sorted.
// (The URL parser already lowercases the host and drops default ports.)
export function normalizeUrl(input) {
  const url = new URL(input)
  url.hash = ''
  const kept = [...url.searchParams.entries()].filter(([name]) => !isTrackingParam(name))
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // stable: repeated names keep their order
  const query = new URLSearchParams(kept).toString()
  url.search = query ? `?${query}` : ''
  return url.href
}

// "Internal" means the same host as the crawl root, ignoring a leading "www.".
// Subdomains (blog.example.com) count as external on purpose: the safe default.
export function hostKey(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '')
}

function hasSkippedExtension(pathname) {
  const lastSegment = pathname.split('/').pop()
  const dot = lastSegment.lastIndexOf('.')
  if (dot === -1) return false
  return SKIPPED_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase())
}

// <meta name="robots" content="nofollow"> means: do not follow any link on this page.
function metaForbidsFollowing($) {
  let forbidden = false
  $('meta').each((_, element) => {
    const name = ($(element).attr('name') ?? '').toLowerCase()
    if (name !== 'robots' && name !== 'webbiebot') return
    const directives = ($(element).attr('content') ?? '').toLowerCase().split(',').map((part) => part.trim())
    if (directives.includes('nofollow') || directives.includes('none')) forbidden = true
  })
  return forbidden
}

// Relative links resolve against <base href> when the page has one, but only if it is http(s).
function resolveBase($, pageUrl) {
  const href = $('base[href]').first().attr('href')
  if (!href) return pageUrl
  try {
    const base = new URL(href, pageUrl)
    return base.protocol === 'http:' || base.protocol === 'https:' ? base : pageUrl
  } catch {
    return pageUrl
  }
}

// -> { title, links: [{ url, text, scope, follow }], truncated, nofollowAll }
//   scope:  'internal' | 'external'
//   follow: false when the link or the page says nofollow (still reported, never queued)
export function extractLinks(html, pageUrl, { rootHost, maxLinks = MAX_LINKS_PER_PAGE } = {}) {
  const page = new URL(pageUrl)
  const pageKey = normalizeUrl(page)
  const scopeKey = hostKey(rootHost ?? page.hostname)

  const $ = cheerio.load(typeof html === 'string' ? html : '')
  const base = resolveBase($, page)
  const nofollowAll = metaForbidsFollowing($)
  const title = collapseWhitespace($('title').first().text()).slice(0, MAX_TITLE_LENGTH)

  const byUrl = new Map() // insertion order = document order
  let truncated = false

  $('a[href]').each((_, element) => {
    const anchor = $(element)
    if (anchor.attr('download') !== undefined) return // the page itself says "this is a file"

    let target
    try {
      target = new URL(anchor.attr('href').trim(), base)
    } catch {
      return // malformed href
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return // mailto:, javascript:, tel:, data:
    if (target.username || target.password) return
    if (hasSkippedExtension(target.pathname)) return

    const url = normalizeUrl(target)
    if (url === pageKey) return // links back to this very page (#top, "", /same)

    const rel = (anchor.attr('rel') ?? '').toLowerCase().split(/\s+/)
    const follow = !nofollowAll && !rel.includes('nofollow')

    const text = (
      collapseWhitespace(anchor.text()) ||
      collapseWhitespace(anchor.find('img[alt]').first().attr('alt') ?? '') ||
      collapseWhitespace(anchor.attr('title') ?? '')
    ).slice(0, MAX_TEXT_LENGTH)

    const existing = byUrl.get(url)
    if (existing) {
      existing.follow = existing.follow || follow
      if (!existing.text && text) existing.text = text
      return
    }
    if (byUrl.size >= maxLinks) {
      truncated = true
      return
    }
    byUrl.set(url, {
      url,
      text,
      scope: hostKey(target.hostname) === scopeKey ? 'internal' : 'external',
      follow,
    })
  })

  return { title, links: [...byUrl.values()], truncated, nofollowAll }
}