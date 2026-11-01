import { useEffect, useRef, useState } from 'react'
import WebPage from './components/WebPage.jsx'
import CrawlerCanvas from './components/CrawlerCanvas.jsx'
import MinimalControls from './components/MinimalControls.jsx'
import { useCrawlerAnimation } from './hooks/useCrawlerAnimation.js'

export default function App() {
  const pageRef = useRef(null)
  const canvasRef = useRef(null)

  // Respect reduced-motion: start paused, the person can press "start".
  const [running, setRunning] = useState(
    () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [speed, setSpeed] = useState(1)
  const [debug, setDebug] = useState(() => new URLSearchParams(window.location.search).has('debug'))

  const { reset } = useCrawlerAnimation({ canvasRef, pageRef, running, speed, debug })

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key.toLowerCase() === 'd' && !event.metaKey && !event.ctrlKey) {
        setDebug((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <WebPage ref={pageRef} />
      <CrawlerCanvas ref={canvasRef} />
      <MinimalControls
        running={running}
        speed={speed}
        onStart={() => setRunning(true)}
        onPause={() => setRunning(false)}
        onReset={reset}
        onSpeedChange={setSpeed}
      />
    </>
  )
}