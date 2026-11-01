import { useCallback, useEffect, useRef } from 'react'
import { createCrawlerEngine } from '../crawler/engine.js'
import { collectTargets } from '../crawler/targets.js'
import { renderScene } from '../crawler/render.js'

// Owns the browser plumbing: canvas sizing (DPR), observers, and the rAF loop.
// Per-frame state lives in refs/closures, never in React state, so nothing re-renders at 60 fps.
export function useCrawlerAnimation({ canvasRef, pageRef, running, speed, debug }) {
  const engineRef = useRef(null)
  const controlsRef = useRef({ running, speed, debug })

  useEffect(() => {
    controlsRef.current = { running, speed, debug }
  }, [running, speed, debug])

  useEffect(() => {
    const canvas = canvasRef.current
    const page = pageRef.current
    if (!canvas || !page) return undefined

    const ctx = canvas.getContext('2d')
    const engine = createCrawlerEngine()
    engineRef.current = engine

    let frameId = 0
    let lastTime = performance.now()
    let frameTimeAverage = 1 / 60
    let layoutDirty = true
    let size = { width: 0, height: 0, dpr: 1 }

    const resizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = window.innerWidth
      const height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      size = { width, height, dpr }
      layoutDirty = true
    }

    const markLayoutDirty = () => {
      layoutDirty = true
    }

    const remeasure = () => {
      engine.setTargets(collectTargets(page))
      layoutDirty = false
    }

    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)
    const resizeObserver = new ResizeObserver(markLayoutDirty) // page height can change without a window resize
    resizeObserver.observe(page)
    if (document.fonts?.ready) document.fonts.ready.then(markLayoutDirty) // web fonts change link positions

    const tick = (now) => {
      frameId = requestAnimationFrame(tick)

      const dt = Math.min((now - lastTime) / 1000, 0.05) // clamp: a hidden tab must not cause a huge jump
      lastTime = now
      frameTimeAverage += (dt - frameTimeAverage) * 0.05

      // Adapt the amount of work to the device (with hysteresis so it does not flicker).
      if (frameTimeAverage > 0.025) engine.setQuality(0.5)
      else if (frameTimeAverage < 0.019) engine.setQuality(1)

      if (layoutDirty) remeasure()

      const controls = controlsRef.current
      const scrollX = window.scrollX
      const scrollY = window.scrollY
      engine.setView({ top: scrollY, height: size.height })
      if (controls.running) engine.update(dt * controls.speed)

      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      ctx.clearRect(0, 0, size.width, size.height)
      renderScene(ctx, engine, {
        scrollX,
        scrollY,
        width: size.width,
        height: size.height,
        debug: controls.debug,
        running: controls.running,
        fps: 1 / frameTimeAverage,
      })
    }
    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', resizeCanvas)
      resizeObserver.disconnect()
      engineRef.current = null
    }
  }, [canvasRef, pageRef])

  const reset = useCallback(() => engineRef.current?.reset(), [])
  return { reset }
}