// Pure data + geometry. No drawing here.
// All coordinates are DOCUMENT coordinates (page space), never viewport coordinates.
let idCounter = 0

// Edges can have joints: each is placed by (t along the edge, sideways offset in px).
// Storing joints relatively means they follow the endpoints if links move after a resize.
function makeVias(count) {
  const vias = []
  for (let i = 0; i < count; i++) {
    vias.push({
      t: 0.2 + Math.random() * 0.6,
      offset: (Math.random() - 0.5) * 2 * (12 + Math.random() * 30),
      dot: Math.random() < 0.7,
    })
  }
  return vias.sort((p, q) => p.t - q.t)
}

export class CrawlGraph {
  constructor() {
    this.clear()
  }

  clear() {
    for (const node of this.nodes ?? []) node.dead = true
    this.nodes = []
    this.edges = []
    this.nodeByTarget = new Map()
  }

  // 'visited' = the crawler has been there. Otherwise it is only 'frontier' (discovered).
  stateOf(targetId) {
    const node = this.nodeByTarget.get(targetId)
    if (!node) return null
    return node.visited ? 'visited' : 'frontier'
  }

  isAlive(node) {
    return !node.dead
  }

  // A node tied to a real link on the page.
  nodeForTarget(target, now, { visited = false, life = 14 } = {}) {
    let node = this.nodeByTarget.get(target.id)
    if (!node) {
      node = {
        id: ++idCounter,
        targetId: target.id,
        x: target.cx,
        y: target.cy,
        born: now,
        expires: now + life,
        visited: false,
        dead: false,
      }
      this.nodes.push(node)
      this.nodeByTarget.set(target.id, node)
    }
    node.expires = Math.max(node.expires, now + life)
    if (visited) node.visited = true
    return node
  }

  connect(a, b, now, { life = 10, color = 'cyan', vias = 2, strong = false, flow = false } = {}) {
    const existing = this.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))
    if (existing) {
      existing.expires = Math.max(existing.expires, now + life)
      return existing
    }
    const edge = {
      id: ++idCounter,
      a,
      b,
      born: now,
      expires: now + life,
      color,
      strong,
      flow, // only "flow" edges carry travelling particles
      vias: makeVias(vias),
      particles: [],
    }
    this.edges.push(edge)
    return edge
  }

  // After a resize the links move; keep nodes glued to their links.
  relocate(targetMap) {
    for (const node of this.nodes) {
      const target = targetMap.get(node.targetId)
      if (target) {
        node.x = target.cx
        node.y = target.cy
      }
    }
  }

  prune(now) {
    const alive = []
    for (const node of this.nodes) {
      if (node.expires > now) {
        alive.push(node)
      } else {
        node.dead = true
        this.nodeByTarget.delete(node.targetId)
      }
    }
    this.nodes = alive
    this.edges = this.edges.filter((e) => e.expires > now && !e.a.dead && !e.b.dead)
  }
}

export function edgePoints(edge) {
  const { a, b } = edge
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  const nx = -dy / length
  const ny = dx / length
  const points = [{ x: a.x, y: a.y }]
  for (const via of edge.vias) {
    points.push({ x: a.x + dx * via.t + nx * via.offset, y: a.y + dy * via.t + ny * via.offset })
  }
  points.push({ x: b.x, y: b.y })
  return points
}

export function polylineLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return total
}

// Point at fraction u (0..1) of the polyline's total length.
export function pointAt(points, u) {
  let remaining = u * polylineLength(points)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const segment = Math.hypot(b.x - a.x, b.y - a.y)
    if (remaining <= segment || i === points.length - 1) {
      const f = segment === 0 ? 0 : Math.min(1, remaining / segment)
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
    }
    remaining -= segment
  }
  return points[0]
}