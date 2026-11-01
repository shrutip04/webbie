import { CrawlGraph } from './graph.js'
import { createCrawlerBody, steer, updateLegs } from './movement.js'
import { pickNextTarget, nearbyTargets } from './targets.js'
import { PALETTE } from './palette.js'
import { CRAWL_EVENTS } from './events.js'

const BASE_LIMITS = { nodes: 160, edges: 200, marks: 36 }
const EDGE_GROW_TIME = 0.5
const EDGE_RETRACT_TIME = 1.2

const pick = (list) => list[Math.floor(Math.random() * list.length)]

const KIND_COLOR = {
  isbn: PALETTE.cyan,
  oclc: PALETTE.pink,
  doi: PALETTE.pink,
  pmid: PALETTE.pink,
  pmc: PALETTE.pink,
  bibcode: PALETTE.amber,
  external: PALETTE.cyan,
  internal: PALETTE.blue,
  cite: PALETTE.purple,
}

// The engine owns simulation state. It never touches the DOM or the canvas:
// it receives targets (measured rectangles) and exposes state for render.js.
export function createCrawlerEngine() {
  const graph = new CrawlGraph()
  const state = {
    clock: 0, // simulation time in seconds; does not advance while paused
    quality: 1,
    targets: [],
    targetMap: new Map(),
    view: { top: 0, height: 800 },
    marks: [],
    pulses: [],
    scheduled: [],
    crawler: null,
    lastNode: null, // last LINK node visited (page-level graph)
    activeTargetId: null,
    pickedAt: 0,
    nextAmbientAt: 0,
  }

  const limit = (name) => Math.round(BASE_LIMITS[name] * state.quality)

  function inViewTargets() {
    return state.targets.filter(
      (t) => t.cy > state.view.top && t.cy < state.view.top + state.view.height,
    )
  }

  function addMark(mark) {
    state.marks.push({ born: state.clock, ...mark })
    while (state.marks.length > limit('marks')) state.marks.shift()
  }

  function addParticles(edge, count) {
    const chord = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y)
    for (let i = 0; i < count; i++) {
      edge.particles.push({
        u: -i * 0.25,
        speed: (150 + Math.random() * 150) / Math.max(60, chord),
      })
    }
  }

  // ---- events (the seam where a real crawler will plug in later) ----

  function dispatch(event) {
    switch (event.type) {
      case CRAWL_EVENTS.MOVED:
        beginMove(event.targetId)
        break
      case CRAWL_EVENTS.LINK_DISCOVERED:
        discoverLink(event.fromId, event.toId)
        break
      default:
        break
    }
  }

  // "Head for this link": the body will steer toward it.
  function beginMove(targetId) {
    if (!state.targetMap.has(targetId)) return
    state.activeTargetId = targetId
    state.pickedAt = state.clock
    state.marks = state.marks.filter((m) => m.kind !== 'select')
    addMark({ kind: 'select', targetId, color: PALETTE.amber, life: 8 })
  }

  function discoverLink(fromId, toId) {
    const from = state.targetMap.get(fromId)
    const to = state.targetMap.get(toId)
    if (!from || !to) return
    const now = state.clock
    const fromNode = graph.nodeForTarget(from, now)
    const toNode = graph.nodeForTarget(to, now, { life: 12 })
    const edge = graph.connect(fromNode, toNode, now, {
      life: 7,
      color: pick(['cyan', 'blue', 'blue', 'purple']),
      vias: 1 + Math.floor(Math.random() * 2),
      flow: true,
    })
    addMark({ kind: 'outline', targetId: toId, color: PALETTE.cyan, life: 1.1, thin: true, alpha: 0.8 })
    addParticles(edge, 1)
  }

  // ---- simulated driver ----

  function chooseTarget() {
    const crawler = state.crawler
    if (!crawler) return
    const next = pickNextTarget(
      state.targets,
      crawler,
      state.view,
      (id) => graph.stateOf(id),
      state.activeTargetId,
    )
    if (next) dispatch({ type: CRAWL_EVENTS.MOVED, targetId: next.id })
  }

  function reactTo(target) {
    const color = KIND_COLOR[target.kind] ?? PALETTE.cyan
    addMark({ kind: 'outline', targetId: target.id, color, life: 1.8 })

    const roll = Math.random()
    if (roll < 0.35) {
      const filled = Math.random() < 0.55
      addMark({
        kind: 'magnify',
        targetId: target.id,
        filled,
        color: filled ? PALETTE.pink : PALETTE.cyan,
        life: 1.3,
      })
    } else if (roll < 0.5) {
      addMark({ kind: 'bar', targetId: target.id, color: PALETTE.cyan, life: 1.2, scale: 1 + Math.random() })
    } else if (roll < 0.62) {
      addMark({
        kind: 'slash',
        targetId: target.id,
        color: PALETTE.pink,
        life: 0.9,
        angle: 0.32,
        length: 180 + Math.random() * 90,
        drift: -30 + Math.random() * 60,
      })
    }
  }

  // The body has reached a link: visit it, react, and keep walking.
  function arrive(target) {
    const now = state.clock
    const node = graph.nodeForTarget(target, now, { visited: true })

    if (state.lastNode && state.lastNode !== node && graph.isAlive(state.lastNode)) {
      const edge = graph.connect(state.lastNode, node, now, {
        life: 10,
        color: 'cyan',
        vias: 2,
        strong: true,
        flow: true,
      })
      addParticles(edge, 2)
    }
    state.lastNode = node

    state.pulses.push({ x: target.cx, y: target.cy, born: now, life: 0.9, color: PALETTE.pink })
    reactTo(target)

    // SIMULATED: pretend the nearest links were "found on this page".
    nearbyTargets(state.targets, target, 300, 3).forEach((neighbour, i) => {
      state.scheduled.push({
        at: now + 0.15 + i * 0.2,
        event: { type: CRAWL_EVENTS.LINK_DISCOVERED, fromId: target.id, toId: neighbour.id },
      })
    })
  }

  function hasArrived(crawler, target) {
    const insideLink =
      Math.abs(crawler.x - target.cx) < target.w / 2 + 4 &&
      Math.abs(crawler.y - target.cy) < target.h / 2 + 4
    return insideLink || Math.hypot(crawler.x - target.cx, crawler.y - target.cy) < 12
  }

  function spawnCrawler() {
    const pool = inViewTargets()
    const start = pool.length ? pick(pool) : state.targets[0]
    if (!start) return
    state.crawler = createCrawlerBody(start.cx, start.cy, Math.random() * Math.PI * 2)
    state.lastNode = graph.nodeForTarget(start, state.clock, { visited: true })
    state.activeTargetId = start.id
    addMark({ kind: 'outline', targetId: start.id, color: PALETTE.pink, life: 1.6 })
    chooseTarget()
  }

  // ---- per-frame update ----

  function updateCrawler(dt, now) {
    const crawler = state.crawler
    if (!crawler) {
      if (state.targets.length) spawnCrawler()
      return
    }

    let target = state.targetMap.get(state.activeTargetId)
    if (!target || now - state.pickedAt > 7) {
      chooseTarget() // target vanished (layout change) or we are stuck: pick another
      target = state.targetMap.get(state.activeTargetId)
    }

    if (target) {
      // If the person scrolled away, hurry back so the crawler stays on screen.
      const offscreen =
        crawler.y < state.view.top - 120 || crawler.y > state.view.top + state.view.height + 120
      steer(crawler, target, dt, now, offscreen ? 2.4 : 1)
      if (hasArrived(crawler, target)) {
        arrive(target)
        chooseTarget()
      }
    }

    updateLegs(crawler, dt, now)
  }

  function updateParticles(dt, now) {
    for (const edge of graph.edges) {
      if (!edge.flow) continue
      if (now - edge.born < EDGE_GROW_TIME) continue
      if (edge.expires - now < EDGE_RETRACT_TIME) continue
      for (let i = edge.particles.length - 1; i >= 0; i--) {
        edge.particles[i].u += edge.particles[i].speed * dt
        if (edge.particles[i].u > 1) edge.particles.splice(i, 1)
      }
      if (edge.particles.length < 2 && Math.random() < dt * 0.3 * state.quality) addParticles(edge, 1)
    }
  }

  // Short-lived marks on random visible links: the page "flickers" under attention.
  function updateAmbient(now) {
    if (now < state.nextAmbientAt || !state.targets.length) return
    state.nextAmbientAt = now + 0.5 + Math.random() * 1.5
    const pool = inViewTargets()
    if (!pool.length) return
    const target = pick(pool)
    const roll = Math.random()
    if (roll < 0.6) {
      addMark({
        kind: 'outline',
        targetId: target.id,
        color: pick([PALETTE.amber, PALETTE.purple, PALETTE.cyan]),
        life: 0.5 + Math.random() * 0.9,
        thin: true,
        alpha: 0.7,
      })
    } else if (roll < 0.85) {
      addMark({
        kind: 'bar',
        targetId: target.id,
        color: pick([PALETTE.cyan, PALETTE.pink]),
        life: 0.9,
        scale: 1 + Math.random(),
      })
    } else {
      const filled = Math.random() < 0.5
      addMark({
        kind: 'magnify',
        targetId: target.id,
        filled,
        color: filled ? PALETTE.pink : PALETTE.cyan,
        life: 0.8,
      })
    }
  }

  function enforceLimits(now) {
    const retire = (list, cap) => {
      for (let i = 0; i < list.length - cap; i++) list[i].expires = Math.min(list[i].expires, now + 1)
    }
    retire(graph.nodes, limit('nodes'))
    retire(graph.edges, limit('edges'))
  }

  function update(dt) {
    state.clock += dt
    const now = state.clock

    if (state.scheduled.length) {
      const due = state.scheduled.filter((item) => item.at <= now)
      if (due.length) {
        state.scheduled = state.scheduled.filter((item) => item.at > now)
        due.forEach((item) => dispatch(item.event))
      }
    }

    updateCrawler(dt, now)
    updateParticles(dt, now)
    updateAmbient(now)

    state.marks = state.marks.filter((m) => now - m.born < m.life)
    state.pulses = state.pulses.filter((p) => now - p.born < p.life)
    enforceLimits(now)
    graph.prune(now)
  }

  // ---- inputs from the outside world ----

  function setTargets(targets) {
    state.targets = targets
    state.targetMap = new Map(targets.map((t) => [t.id, t]))
    graph.relocate(state.targetMap)
  }

  function setView(view) {
    state.view = view
  }

  function setQuality(quality) {
    state.quality = quality
  }

  function reset() {
    graph.clear()
    state.clock = 0
    state.marks = []
    state.pulses = []
    state.scheduled = []
    state.crawler = null
    state.lastNode = null
    state.activeTargetId = null
    state.pickedAt = 0
    state.nextAmbientAt = 0
    spawnCrawler()
  }

  return { graph, state, update, dispatch, reset, setTargets, setView, setQuality }
}

export { EDGE_GROW_TIME, EDGE_RETRACT_TIME }