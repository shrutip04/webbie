import { forwardRef } from 'react'

// A dumb element on purpose: size, DPR and drawing are handled by the animation hook.
const CrawlerCanvas = forwardRef(function CrawlerCanvas(_props, ref) {
  return <canvas ref={ref} className="crawler-canvas" aria-hidden="true" />
})

export default CrawlerCanvas