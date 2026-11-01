import { runCrawl } from '../src/crawler.js'
import { UrlGuardError } from '../src/urlGuard.js'

// A command-line way to watch a real crawl: npm run crawl -- https://example.com 1 5
const [rootUrl, depthArg, pagesArg] = process.argv.slice(2)
if (!rootUrl) {
  console.error('Usage: npm run crawl -- <url> [maxDepth] [maxPages]')
  process.exit(1)
}

const controller = new AbortController()
process.on('SIGINT', () => {
  console.log('\nstopping...')
  controller.abort()
})

const emit = (event) => {
  switch (event.type) {
    case 'crawl:started':
      console.log(`start   ${event.rootUrl}  (depth <= ${event.limits.maxDepth}, pages <= ${event.limits.maxPages})`)
      break
    case 'crawler:moved':
      console.log(`visit   ${event.toUrl}`)
      break
    case 'page:fetched':
      console.log(`        ${event.status}  ${event.bytes} bytes  "${event.title}"  ${event.linkCount} links  ${event.durationMs} ms`)
      break
    case 'page:error':
      console.log(`        error ${event.code}: ${event.url}`)
      break
    case 'crawl:completed':
      console.log(`done    ${event.pages} pages, ${event.links} links, ${event.errors} errors (${event.reason})`)
      break
    default:
      break
  }
}

try {
  await runCrawl(rootUrl, { limits: { maxDepth: Number(depthArg), maxPages: Number(pagesArg) }, emit, signal: controller.signal })
} catch (error) {
  if (error instanceof UrlGuardError) {
    console.error(`Refused: ${error.message} (${error.code})`)
    process.exitCode = 1
  } else {
    throw error
  }
}