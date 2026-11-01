import { PALETTE } from './palette.js'
import { edgePoints, pointAt, polylineLength } from './graph.js'
import { EDGE_GROW_TIME, EDGE_RETRACT_TIME } from './engine.js'

const TAU = Math.PI * 2
const MONO = '"JetBrains Mono", Consolas, "Courier New", monospace'
const clamp01 = (v) => Math.min(1, Math.max(0, v))
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Draws the engine's state. Uses document coordinates + a translate(-scroll),
// so overlay elements stay glued to the page while scrolling.
export function renderScene(ctx, engine, frame) {
  const { graph, state } = engine
  const { scrollX, scrollY, width, height, debug } = frame
  const now = state.clock
  const view = {
    left: scrollX - 80,
    right: scrollX + width + 80,
    top: scrollY - 80,
    bottom: scrollY + height + 80,
  }

  ctx.save()
  ctx.translate(-scrollX, -scrollY)

  drawMarks(ctx, state, view, now)
  drawEdges(ctx, graph, view, now)
  drawNodes(ctx, graph, view, now)
  drawPulses(ctx, state, now)
  drawCrawler(ctx, state) // last, so the spider is always on top
  if (debug) drawDebugWorld(ctx, state, graph)

  ctx.restore()
  if (debug) drawDebugHud(ctx, engine, frame)
}

function isOutside(view, a, b) {
  return (
    Math.max(a.x, b.x) < view.left ||
    Math.min(a.x, b.x) > view.right ||
    Math.max(a.y, b.y) < view.top ||
    Math.min(a.y, b.y) > view.bottom
  )
}

// ---------- marks: outlines, bars, magnified text, slashes ----------

function drawMarks(ctx, state, view, now) {
  for (const mark of state.marks) {
    const rect = state.targetMap.get(mark.targetId) // resolved every frame: always current layout
    if (!rect) continue
    if (rect.y > view.bottom || rect.y + rect.h < view.top) continue
    drawMark(ctx, mark, rect, now)
  }
}

function drawMark(ctx, mark, rect, now) {
  const age = now - mark.born
  const fade = 1 - clamp01(age / mark.life)

  ctx.save()
  switch (mark.kind) {
    case 'select': {
      ctx.globalAlpha = 0.85
      ctx.strokeStyle = mark.color
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeRect(rect.x - 3.5, rect.y - 2.5, rect.w + 7, rect.h + 5)
      break
    }
    case 'outline': {
      ctx.globalAlpha = fade * (mark.alpha ?? 1)
      ctx.strokeStyle = mark.color
      ctx.lineWidth = mark.thin ? 1 : age < 0.12 ? 3 : 1.25
      ctx.strokeRect(rect.x - 3, rect.y - 2, rect.w + 6, rect.h + 4)
      break
    }
    case 'bar': {
      const grow = clamp01(age / 0.18)
      ctx.globalAlpha = 0.9 * fade
      ctx.fillStyle = mark.color
      ctx.fillRect(rect.x - 4, rect.y - 9, rect.w * mark.scale * grow, 9)
      break
    }
    case 'magnify': {
      const size = Math.max(16, rect.h * 1.5)
      const text = clip(rect.text, 22)
      ctx.font = `600 ${size}px ${MONO}`
      ctx.textBaseline = 'middle'
      const textWidth = ctx.measureText(text).width
      const x = rect.x - 6
      const centerY = rect.cy
      ctx.globalAlpha = Math.min(1, fade * 1.6)
      if (mark.filled) {
        ctx.fillStyle = mark.color
        ctx.fillRect(x, centerY - size * 0.7, textWidth + 14, size * 1.4)
        ctx.fillStyle = '#ffffff'
      } else {
        ctx.fillStyle = mark.color
      }
      ctx.fillText(text, x + 7, centerY)
      break
    }
    case 'slash': {
      ctx.globalAlpha = 0.85 * fade
      ctx.translate(rect.cx + mark.drift * age, rect.cy)
      ctx.rotate(mark.angle)
      ctx.fillStyle = mark.color
      ctx.fillRect(-7, -mark.length / 2, 14, mark.length)
      break
    }
    default:
      break
  }
  ctx.restore()
}

// ---------- edges (angular polylines that grow and retract) + particles ----------

function strokeRange(ctx, points, from, to) {
  const lengths = []
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    lengths.push(l)
    total += l
  }
  const start = from * total
  const end = to * total
  let walked = 0
  let started = false
  ctx.beginPath()
  for (let i = 0; i < lengths.length; i++) {
    const segStart = walked
    const segEnd = walked + lengths[i]
    walked = segEnd
    if (segEnd < start || segStart > end || lengths[i] === 0) continue
    const t0 = (Math.max(start, segStart) - segStart) / lengths[i]
    const t1 = (Math.min(end, segEnd) - segStart) / lengths[i]
    const a = points[i]
    const b = points[i + 1]
    const x0 = a.x + (b.x - a.x) * t0
    const y0 = a.y + (b.y - a.y) * t0
    if (!started) {
      ctx.moveTo(x0, y0)
      started = true
    }
    ctx.lineTo(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1)
  }
  ctx.stroke()
}

function drawEdges(ctx, graph, view, now) {
  ctx.lineWidth = 1
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const edge of graph.edges) {
    if (isOutside(view, edge.a, edge.b)) continue

    const grow = clamp01((now - edge.born) / EDGE_GROW_TIME)
    const remaining = edge.expires - now
    const retract = remaining < EDGE_RETRACT_TIME ? 1 - remaining / EDGE_RETRACT_TIME : 0
    if (retract >= grow) continue

    const points = edgePoints(edge)
    ctx.globalAlpha = edge.strong ? 0.6 : 0.35 // quieter lines keep the spider readable
    ctx.strokeStyle = PALETTE[edge.color]
    strokeRange(ctx, points, retract, grow)

    if (grow < 1 || retract > 0) continue

    // joint dots
    ctx.globalAlpha = 0.8
    ctx.fillStyle = PALETTE.pink
    ctx.beginPath()
    for (let i = 1; i < points.length - 1; i++) {
      if (!edge.vias[i - 1].dot) continue
      ctx.moveTo(points[i].x + 1.8, points[i].y)
      ctx.arc(points[i].x, points[i].y, 1.8, 0, TAU)
    }
    ctx.fill()

    // particles with a short bright tail
    if (edge.particles.length) {
      const total = polylineLength(points)
      ctx.lineWidth = 1.6
      ctx.strokeStyle = PALETTE.white
      ctx.globalAlpha = 0.9
      for (const p of edge.particles) {
        if (p.u < 0 || p.u > 1) continue
        const head = pointAt(points, p.u)
        const tail = pointAt(points, Math.max(0, p.u - 10 / total))
        ctx.beginPath()
        ctx.moveTo(tail.x, tail.y)
        ctx.lineTo(head.x, head.y)
        ctx.stroke()
      }
      ctx.lineWidth = 1
    }
  }
  ctx.globalAlpha = 1
}

// ---------- nodes, pulses, crawler ----------

function drawNodes(ctx, graph, view, now) {
  for (const node of graph.nodes) {
    if (node.x < view.left || node.x > view.right || node.y < view.top || node.y > view.bottom) continue

    const pop = clamp01((now - node.born) / 0.25)
    const fade = clamp01((node.expires - now) / 1)
    ctx.globalAlpha = fade

    const radius = (node.visited ? 3.4 : 2.4) * (0.5 + 0.5 * pop)
    ctx.fillStyle = node.visited ? PALETTE.cyan : PALETTE.pink
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius, 0, TAU)
    ctx.fill()
    if (node.visited) {
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius * 0.45, 0, TAU)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

function drawPulses(ctx, state, now) {
  ctx.lineWidth = 1
  for (const pulse of state.pulses) {
    const p = clamp01((now - pulse.born) / pulse.life)
    ctx.globalAlpha = 1 - p
    ctx.strokeStyle = pulse.color
    ctx.beginPath()
    ctx.arc(pulse.x, pulse.y, 4 + p * 26, 0, TAU)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawCrawler(ctx, state) {
  const crawler = state.crawler
  if (!crawler) return

  // Dark halo: dims the page text right under the spider so it separates from the page.
  const haloRadius = 95
  const halo = ctx.createRadialGradient(crawler.x, crawler.y, 10, crawler.x, crawler.y, haloRadius)
  halo.addColorStop(0, 'rgba(3, 3, 8, 0.85)')
  halo.addColorStop(0.6, 'rgba(3, 3, 8, 0.55)')
  halo.addColorStop(1, 'rgba(3, 3, 8, 0)')
  ctx.globalAlpha = 1
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(crawler.x, crawler.y, haloRadius, 0, TAU)
  ctx.fill()

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const strokeLegs = () => {
    ctx.beginPath()
    for (const leg of crawler.legs) {
      ctx.moveTo(leg.hipX, leg.hipY)
      ctx.lineTo(leg.kneeX, leg.kneeY)
      ctx.lineTo(leg.fx, leg.fy)
    }
    ctx.stroke()
  }

  // legs: black outline first, then the bright line on top
  ctx.strokeStyle = '#000000'
  ctx.globalAlpha = 0.9
  ctx.lineWidth = 4.5
  strokeLegs()
  ctx.strokeStyle = PALETTE.cyan
  ctx.globalAlpha = 1
  ctx.lineWidth = 2
  strokeLegs()

  // knees
  ctx.fillStyle = PALETTE.cyan
  ctx.beginPath()
  for (const leg of crawler.legs) {
    ctx.moveTo(leg.kneeX + 2.4, leg.kneeY)
    ctx.arc(leg.kneeX, leg.kneeY, 2.4, 0, TAU)
  }
  ctx.fill()

  // feet: dark ring, then pink (white while the foot is in the air)
  for (const leg of crawler.legs) {
    ctx.fillStyle = '#000000'
    ctx.beginPath()
    ctx.arc(leg.fx, leg.fy, 4.4, 0, TAU)
    ctx.fill()
    ctx.fillStyle = leg.stepping ? PALETTE.white : PALETTE.pink
    ctx.beginPath()
    ctx.arc(leg.fx, leg.fy, 3, 0, TAU)
    ctx.fill()
  }

  // body: abdomen behind the head, joined by a thick line
  const forwardX = Math.cos(crawler.heading)
  const forwardY = Math.sin(crawler.heading)
  const abdomenX = crawler.x - forwardX * 15
  const abdomenY = crawler.y - forwardY * 15

  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(crawler.x, crawler.y)
  ctx.lineTo(abdomenX, abdomenY)
  ctx.stroke()
  ctx.strokeStyle = PALETTE.white
  ctx.lineWidth = 2.5
  ctx.stroke()

  ctx.fillStyle = '#000000'
  ctx.beginPath()
  ctx.arc(abdomenX, abdomenY, 9, 0, TAU)
  ctx.fill()
  ctx.fillStyle = PALETTE.pink
  ctx.beginPath()
  ctx.arc(abdomenX, abdomenY, 7, 0, TAU)
  ctx.fill()
  ctx.fillStyle = PALETTE.white
  ctx.beginPath()
  ctx.arc(abdomenX, abdomenY, 2.5, 0, TAU)
  ctx.fill()

  // head
  ctx.fillStyle = '#000000'
  ctx.beginPath()
  ctx.arc(crawler.x, crawler.y, 7, 0, TAU)
  ctx.fill()
  ctx.fillStyle = PALETTE.white
  ctx.beginPath()
  ctx.arc(crawler.x, crawler.y, 5, 0, TAU)
  ctx.fill()
  ctx.strokeStyle = PALETTE.cyan
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(crawler.x, crawler.y, 8.5, 0, TAU)
  ctx.stroke()
}

// ---------- debug ----------

function drawDebugWorld(ctx, state, graph) {
  ctx.lineWidth = 1
  ctx.strokeStyle = '#888'
  ctx.globalAlpha = 0.35
  for (const t of state.targets) ctx.strokeRect(t.x, t.y, t.w, t.h)

  const active = state.targetMap.get(state.activeTargetId)
  if (active) {
    ctx.globalAlpha = 1
    ctx.strokeStyle = '#7CFC00'
    ctx.strokeRect(active.x - 2, active.y - 2, active.w + 4, active.h + 4)

    const crawler = state.crawler
    if (crawler) {
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = '#ffd400'
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(crawler.x, crawler.y)
      ctx.lineTo(active.cx, active.cy)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  ctx.globalAlpha = 1
  ctx.fillStyle = '#ffd400'
  ctx.font = `10px ${MONO}`
  ctx.textBaseline = 'alphabetic'
  for (const node of graph.nodes) {
    ctx.fillText(`${node.visited ? 'V' : 'F'}${node.id}`, node.x + 6, node.y - 6)
  }
}

function drawDebugHud(ctx, engine, frame) {
  const { state, graph } = engine
  const lines = [
    `fps ${frame.fps.toFixed(0)}   quality ${state.quality}`,
    `clock ${state.clock.toFixed(1)}s   ${frame.running ? 'running' : 'paused'}`,
    `targets ${state.targets.length}   nodes ${graph.nodes.length}   edges ${graph.edges.length}   marks ${state.marks.length}`,
    `crawler ${Math.round(state.crawler?.speed ?? 0)} px/s → ${state.activeTargetId ?? '-'}`,
  ]
  ctx.save()
  ctx.font = `11px ${MONO}`
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(0,0,0,0.7)'
  ctx.fillRect(8, 8, 430, lines.length * 15 + 8)
  ctx.fillStyle = '#7CFC00'
  lines.forEach((line, i) => ctx.fillText(line, 14, 12 + i * 15))
  ctx.restore()
}