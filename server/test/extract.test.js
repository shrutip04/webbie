import test from 'node:test'
import assert from 'node:assert/strict'
import { extractLinks, normalizeUrl, hostKey } from '../src/extract.js'

const urls = (result) => result.links.map((link) => link.url)

test('resolves relative links against the page URL and reports scope', () => {
  const html = `
    <a href="/root">R</a>
    <a href="sibling">S</a>
    <a href="../up">U</a>
    <a href="https://other.org/x">O</a>`
  const result = extractLinks(html, 'https://example.com/docs/page')
  assert.deepEqual(urls(result), [
    'https://example.com/root',
    'https://example.com/docs/sibling',
    'https://example.com/up',
    'https://other.org/x',
  ])
  assert.deepEqual(result.links.map((link) => link.scope), ['internal', 'internal', 'internal', 'external'])
})

test('protocol-relative links take the page scheme', () => {
  const result = extractLinks('<a href="//cdn.example.org/p">x</a>', 'https://example.com/')
  assert.deepEqual(urls(result), ['https://cdn.example.org/p'])
})

test('<base href> changes how relative links resolve, but only for http(s)', () => {
  const withBase = extractLinks('<base href="https://example.com/docs/"><a href="intro">i</a>', 'https://example.com/x/y')
  assert.deepEqual(urls(withBase), ['https://example.com/docs/intro'])

  const evilBase = extractLinks('<base href="javascript:alert(1)"><a href="intro">i</a>', 'https://example.com/x/')
  assert.deepEqual(urls(evilBase), ['https://example.com/x/intro'])
})

test('skips non-web schemes, credentials, malformed hrefs and downloads', () => {
  const html = `
    <a href="mailto:a@b.com">m</a>
    <a href="javascript:alert(1)">j</a>
    <a href="tel:123">t</a>
    <a href="data:text/html,hi">d</a>
    <a href="https://user:pw@example.com/">c</a>
    <a href="http://[bad">b</a>
    <a href="/file" download>f</a>
    <a href="/ok">ok</a>`
  assert.deepEqual(urls(extractLinks(html, 'https://example.com/')), ['https://example.com/ok'])
})

test('skips links back to the page itself', () => {
  const html = '<a href="#top">a</a><a href="">b</a><a href="/a">c</a><a href="/a?utm_source=z">d</a><a href="/b">e</a>'
  assert.deepEqual(urls(extractLinks(html, 'https://example.com/a')), ['https://example.com/b'])
})

test('skips links to files by extension (case-insensitive)', () => {
  const html = '<a href="/a.pdf">1</a><a href="/b.PNG">2</a><a href="/c.html">3</a><a href="/d">4</a><a href="/e.tar.gz">5</a>'
  assert.deepEqual(urls(extractLinks(html, 'https://example.com/')), [
    'https://example.com/c.html',
    'https://example.com/d',
  ])
})

test('deduplicates by normalized URL, keeping the first position and any useful text', () => {
  const html = '<a href="/x?utm_source=a"></a><a href="/x#frag">Hello</a><a href="/y">Y</a>'
  const result = extractLinks(html, 'https://example.com/')
  assert.deepEqual(urls(result), ['https://example.com/x', 'https://example.com/y'])
  assert.equal(result.links[0].text, 'Hello')
})

test('link text is collapsed, falls back to img alt then title, and is capped', () => {
  const html = `
    <a href="/a">  Hello \n  world </a>
    <a href="/b"><img alt="Logo" src="x.png"></a>
    <a href="/c" title="Tooltip"></a>
    <a href="/d">${'z'.repeat(300)}</a>`
  const result = extractLinks(html, 'https://example.com/')
  assert.deepEqual(result.links.slice(0, 3).map((link) => link.text), ['Hello world', 'Logo', 'Tooltip'])
  assert.equal(result.links[3].text.length, 100)
})

test('scope ignores a leading www but treats subdomains as external', () => {
  const html = '<a href="https://example.com/a">a</a><a href="https://blog.example.com/b">b</a>'
  const result = extractLinks(html, 'https://www.example.com/')
  assert.deepEqual(result.links.map((link) => link.scope), ['internal', 'external'])
})

test('rootHost decides scope when the crawl started somewhere else', () => {
  const result = extractLinks('<a href="https://example.com/a">a</a>', 'https://other.org/page', {
    rootHost: 'example.com',
  })
  assert.equal(result.links[0].scope, 'internal')
})

test('rel="nofollow" links are reported with follow=false', () => {
  const html = '<a rel="nofollow ugc" href="/a">a</a><a rel="noopener" href="/b">b</a><a href="/c">c</a>'
  const result = extractLinks(html, 'https://example.com/')
  assert.deepEqual(result.links.map((link) => link.follow), [false, true, true])
})

test('a robots meta tag with nofollow disables following for every link', () => {
  const html = '<meta name="Robots" content="noindex, nofollow"><a href="/a">a</a>'
  const result = extractLinks(html, 'https://example.com/')
  assert.equal(result.nofollowAll, true)
  assert.equal(result.links[0].follow, false)

  const noindexOnly = extractLinks('<meta name="robots" content="noindex"><a href="/a">a</a>', 'https://example.com/')
  assert.equal(noindexOnly.links[0].follow, true)
})

test('reads and trims the title', () => {
  const result = extractLinks('<title>\n  My   page \n</title>', 'https://example.com/')
  assert.equal(result.title, 'My page')
})

test('caps the number of links and says so', () => {
  const html = Array.from({ length: 250 }, (_, i) => `<a href="/p${i}">p</a>`).join('')
  const result = extractLinks(html, 'https://example.com/')
  assert.equal(result.links.length, 200)
  assert.equal(result.truncated, true)
})

test('tolerates broken or empty HTML', () => {
  assert.doesNotThrow(() => extractLinks('<a href="/x"><div><a href="/y">', 'https://example.com/'))
  assert.deepEqual(extractLinks('', 'https://example.com/').links, [])
  assert.deepEqual(extractLinks(undefined, 'https://example.com/').links, [])
})

test('normalizeUrl drops fragments and tracking params, sorts the rest, lowercases the host', () => {
  assert.equal(
    normalizeUrl('https://Example.com:443/a?b=2&a=1&utm_source=x&fbclid=y#frag'),
    'https://example.com/a?a=1&b=2',
  )
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/')
  assert.equal(normalizeUrl('https://example.com/a?utm_campaign=z'), 'https://example.com/a')
})

test('hostKey strips only a leading www', () => {
  assert.equal(hostKey('WWW.Example.com'), 'example.com')
  assert.equal(hostKey('blog.example.com'), 'blog.example.com')
  assert.equal(hostKey('awww.example.com'), 'awww.example.com')
})