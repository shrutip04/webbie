import { io } from 'socket.io-client'

// Prints every event of a crawl: npm run watch -- <crawlId>
const [crawlId] = process.argv.slice(2)
if (!crawlId) {
  console.error('Usage: npm run watch -- <crawlId>')
  process.exit(1)
}

const socket = io('http://127.0.0.1:3001', { transports: ['websocket'], reconnection: false })

socket.onAny((name, event) => console.log(name.padEnd(16), JSON.stringify(event)))
socket.on('connect', () => {
  socket.emit('subscribe', { crawlId }, (ack) => console.log('subscribed', JSON.stringify(ack)))
})
socket.on('crawl:completed', () => socket.close())
socket.on('connect_error', (error) => {
  console.error(`could not connect: ${error.message}`)
  process.exit(1)
})