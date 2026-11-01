import { createCrawlManager } from './crawlManager.js'
import { createServer } from './app.js'

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '127.0.0.1' // loopback only by default
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : undefined

const manager = createCrawlManager()
const server = createServer({ manager, allowedOrigins })

server.httpServer.listen(port, host, () => {
  console.log(`Webbie server listening on http://${host}:${port}`)
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    console.warn('WARNING: this server is reachable from other machines. Anyone who can reach it can make your computer fetch URLs. Add authentication before doing this.')
  }
})

const shutdown = () => {
  console.log('\nshutting down...')
  server.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)