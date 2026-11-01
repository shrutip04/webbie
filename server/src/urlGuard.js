import dns from 'node:dns/promises'
import net from 'node:net'

// Decides whether a URL may be crawled at all. This is the SSRF gate:
// nothing is fetched unless it passes here.

export class UrlGuardError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UrlGuardError'
    this.code = code
  }
}

const MAX_URL_LENGTH = 2048
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const ALLOWED_PORTS = new Set(['', '80', '443']) // url.port is '' when the scheme default is used

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal'])
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa']

// Private, loopback, link-local (cloud metadata lives at 169.254.169.254),
// carrier-grade NAT, documentation, multicast and reserved ranges.
const blockedRanges = new net.BlockList()
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
const BLOCKED_V6 = [
  ['::', 96],          // unspecified, loopback and IPv4-compatible
  ['64:ff9b::', 96],   // NAT64
  ['100::', 64],       // discard-only
  ['2001::', 32],      // Teredo
  ['2001:db8::', 32],  // documentation
  ['2002::', 16],      // 6to4 (embeds an IPv4 address)
  ['fc00::', 7],       // unique local
  ['fe80::', 10],      // link-local
  ['ff00::', 8],       // multicast
]
for (const [address, prefix] of BLOCKED_V4) blockedRanges.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of BLOCKED_V6) blockedRanges.addSubnet(address, prefix, 'ipv6')

// "::ffff:127.0.0.1" is IPv4 loopback wearing an IPv6 costume. Unwrap it before checking.
function unwrapMappedIPv4(ipv6) {
  const dotted = ipv6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) return dotted[1]
  const hex = ipv6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return null
}

export function isPublicIp(ip) {
  const family = net.isIP(ip)
  if (family === 0) return false // anything we cannot parse is treated as unsafe

  if (family === 6) {
    let canonical
    try {
      // The URL parser rewrites any IPv6 spelling into one canonical form.
      canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase()
    } catch {
      return false
    }
    const mapped = unwrapMappedIPv4(canonical)
    if (mapped) return isPublicIp(mapped)
    return !blockedRanges.check(canonical, 'ipv6')
  }
  return !blockedRanges.check(ip, 'ipv4')
}

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

function isBlockedHostname(host) {
  if (BLOCKED_HOSTNAMES.has(host)) return true
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

// Step 1: checks that need no network. Throws UrlGuardError, returns a clean URL.
export function parseCrawlUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new UrlGuardError('INVALID_URL', 'A URL is required.')
  }
  const raw = input.trim()
  if (raw.length > MAX_URL_LENGTH) {
    throw new UrlGuardError('URL_TOO_LONG', 'The URL is too long.')
  }

  let url
  try {
    url = new URL(raw) // also normalizes tricks like http://2130706433/ or http://0x7f.1/ to 127.0.0.1
  } catch {
    throw new UrlGuardError('INVALID_URL', 'Not a valid absolute URL.')
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlGuardError('UNSUPPORTED_PROTOCOL', 'Only http and https URLs are allowed.')
  }
  if (url.username || url.password) {
    throw new UrlGuardError('CREDENTIALS_NOT_ALLOWED', 'URLs with embedded credentials are not allowed.')
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlGuardError('PORT_NOT_ALLOWED', 'Only the default web ports (80, 443) are allowed.')
  }

  const host = normalizeHostname(url.hostname)
  if (!host) throw new UrlGuardError('INVALID_URL', 'The URL has no host.')

  const isIpLiteral = net.isIP(host) !== 0
  if (isIpLiteral) {
    if (!isPublicIp(host)) throw new UrlGuardError('IP_BLOCKED', 'That IP address is not allowed.')
  } else if (isBlockedHostname(host) || !host.includes('.')) {
    // Single-label names ("intranet") resolve through internal search domains, so they are refused too.
    throw new UrlGuardError('HOST_BLOCKED', 'That host name is not allowed.')
  }

  url.hash = ''
  return url
}

// Step 2: resolve the name and require EVERY address to be public.
// Returns the validated addresses so the fetch step can connect to exactly these
// (pinning), which is what defeats DNS rebinding. `lookup` is injectable for tests.
export async function resolvePublicAddresses(hostname, lookup = dns.lookup) {
  const host = normalizeHostname(hostname)

  const literalFamily = net.isIP(host)
  if (literalFamily !== 0) {
    if (!isPublicIp(host)) throw new UrlGuardError('IP_BLOCKED', 'That IP address is not allowed.')
    return [{ address: host, family: literalFamily }]
  }

  let results
  try {
    results = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new UrlGuardError('DNS_FAILED', `Could not resolve ${host}.`)
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new UrlGuardError('DNS_FAILED', `Could not resolve ${host}.`)
  }

  for (const { address } of results) {
    if (!isPublicIp(address)) {
      throw new UrlGuardError('IP_BLOCKED', `${host} resolves to a disallowed address.`)
    }
  }
  return results.map(({ address, family }) => ({ address, family }))
}

export async function validateCrawlTarget(input, { lookup } = {}) {
  const url = parseCrawlUrl(input)
  const addresses = await resolvePublicAddresses(url.hostname, lookup)
  return { url, addresses }
}