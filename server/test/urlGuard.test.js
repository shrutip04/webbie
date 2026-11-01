import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCrawlUrl,
  isPublicIp,
  validateCrawlTarget,
  UrlGuardError,
} from '../src/urlGuard.js'

const isGuardError = (code) => (error) => error instanceof UrlGuardError && error.code === code
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }]

test('parseCrawlUrl accepts a normal https URL and strips the fragment', () => {
  const url = parseCrawlUrl('https://example.com/a?b=1#section')
  assert.equal(url.href, 'https://example.com/a?b=1')
})

test('parseCrawlUrl rejects unsupported schemes and malformed input', () => {
  const cases = [
    ['ftp://example.com/file', 'UNSUPPORTED_PROTOCOL'],
    ['file:///etc/passwd', 'UNSUPPORTED_PROTOCOL'],
    ['javascript:alert(1)', 'UNSUPPORTED_PROTOCOL'],
    ['example.com', 'INVALID_URL'],
    ['', 'INVALID_URL'],
    ['   ', 'INVALID_URL'],
    [`https://example.com/${'a'.repeat(2100)}`, 'URL_TOO_LONG'],
  ]
  for (const [input, code] of cases) {
    assert.throws(() => parseCrawlUrl(input), isGuardError(code), input)
  }
  assert.throws(() => parseCrawlUrl(undefined), isGuardError('INVALID_URL'))
})

test('parseCrawlUrl rejects credentials and unusual ports', () => {
  assert.throws(() => parseCrawlUrl('https://user:pass@example.com/'), isGuardError('CREDENTIALS_NOT_ALLOWED'))
  assert.throws(() => parseCrawlUrl('https://example.com:22/'), isGuardError('PORT_NOT_ALLOWED'))
  assert.throws(() => parseCrawlUrl('http://example.com:8080/'), isGuardError('PORT_NOT_ALLOWED'))
})

test('parseCrawlUrl rejects local and internal host names', () => {
  const hosts = [
    'http://localhost/',
    'http://LOCALHOST./',
    'http://foo.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://metadata.google.internal/',
    'https://intranet/',
  ]
  for (const input of hosts) {
    assert.throws(() => parseCrawlUrl(input), isGuardError('HOST_BLOCKED'), input)
  }
})

test('parseCrawlUrl rejects private IP literals, including disguised forms', () => {
  const ips = [
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://10.0.0.1/',
    'http://172.16.5.4/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
  ]
  for (const input of ips) {
    assert.throws(() => parseCrawlUrl(input), isGuardError('IP_BLOCKED'), input)
  }
})

test('parseCrawlUrl allows public IP literals', () => {
  assert.equal(parseCrawlUrl('http://8.8.8.8/').hostname, '8.8.8.8')
})

test('isPublicIp classifies addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicIp(ip), true, ip)
  }
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '100.100.100.200',
    '::1', '::', 'fe80::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:a00:1',
    '0:0:0:0:0:ffff:7f00:1', 'not-an-ip', '',
  ]) {
    assert.equal(isPublicIp(ip), false, ip)
  }
})

test('validateCrawlTarget returns the validated addresses for pinning', async () => {
  const { url, addresses } = await validateCrawlTarget('https://example.com/page', { lookup: publicLookup })
  assert.equal(url.hostname, 'example.com')
  assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }])
})

test('validateCrawlTarget rejects a name that resolves to a private address', async () => {
  const lookup = async () => [{ address: '10.0.0.5', family: 4 }]
  await assert.rejects(validateCrawlTarget('https://sneaky.example.com/', { lookup }), isGuardError('IP_BLOCKED'))
})

test('validateCrawlTarget rejects when ANY resolved address is private', async () => {
  const lookup = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]
  await assert.rejects(validateCrawlTarget('https://mixed.example.com/', { lookup }), isGuardError('IP_BLOCKED'))
})

test('validateCrawlTarget fails safely when DNS fails or returns nothing', async () => {
  const failing = async () => {
    throw new Error('ENOTFOUND')
  }
  const empty = async () => []
  await assert.rejects(validateCrawlTarget('https://nope.example.com/', { lookup: failing }), isGuardError('DNS_FAILED'))
  await assert.rejects(validateCrawlTarget('https://nope.example.com/', { lookup: empty }), isGuardError('DNS_FAILED'))
})

test('validateCrawlTarget never calls DNS for URLs that fail the syntax checks', async () => {
  let called = false
  const lookup = async () => {
    called = true
    return [{ address: '8.8.8.8', family: 4 }]
  }
  await assert.rejects(validateCrawlTarget('http://localhost/', { lookup }), isGuardError('HOST_BLOCKED'))
  await assert.rejects(validateCrawlTarget('ftp://example.com/', { lookup }), isGuardError('UNSUPPORTED_PROTOCOL'))
  assert.equal(called, false)
})