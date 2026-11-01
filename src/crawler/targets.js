const LOCAL_RADIUS = 340 // the crawler only considers links this close, so it walks, not jumps
const VIEW_MARGIN_RATIO = 0.3

// Reads REAL DOM rectangles and converts them to document coordinates
// (viewport rect + scroll offset), so they do not drift when the page scrolls.
export function collectTargets(root) {
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const targets = []

  root.querySelectorAll('a[data-target-id]').forEach((element) => {
    const rects = element.getClientRects()
    if (rects.length === 0) return
    const rect = rects[0] // first line box, so wrapped links stay a sensible size
    if (rect.width < 4 || rect.height < 4) return

    const x = rect.left + scrollX
    const y = rect.top + scrollY
    targets.push({
      id: element.dataset.targetId,
      kind: element.dataset.kind,
      text: element.textContent.trim(),
      x,
      y,
      w: rect.width,
      h: rect.height,
      cx: x + rect.width / 2,
      cy: y + rect.height / 2,
    })
  })
  return targets
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))

// Weighted random choice, like a (very small) crawl queue:
//  - only nearby links, so movement is local and continuous
//  - prefers links roughly AHEAD of the current heading (no sharp U-turns)
//  - strongly prefers discovered-but-unvisited links
//  - if the crawler has been scrolled out of view, head back to what is visible
export function pickNextTarget(targets, body, view, getNodeState, currentId) {
  const margin = view.height * VIEW_MARGIN_RATIO
  const inBand = (t) => t.cy > view.top - margin && t.cy < view.top + view.height + margin
  const offscreen = body.y < view.top - 120 || body.y > view.top + view.height + 120

  let pool
  if (offscreen) {
    pool = targets.filter((t) => t.cy > view.top && t.cy < view.top + view.height)
  } else {
    pool = targets.filter(
      (t) => inBand(t) && Math.hypot(t.cx - body.x, t.cy - body.y) <= LOCAL_RADIUS,
    )
  }
  if (pool.length === 0) pool = targets.filter(inBand)
  if (pool.length === 0) pool = targets

  const weights = pool.map((target) => {
    if (target.id === currentId) return 0
    const dx = target.cx - body.x
    const dy = target.cy - body.y
    const distance = Math.hypot(dx, dy)
    if (distance < 25) return 0

    let weight = 1 / (1 + (distance / 180) ** 2)
    const ahead = Math.cos(wrapAngle(Math.atan2(dy, dx) - body.heading))
    weight *= 0.35 + 0.65 * Math.max(0, ahead)

    const state = getNodeState(target.id)
    if (state === 'frontier') weight *= 6
    else if (state === 'visited') weight *= 0.25
    return weight
  })

  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return pool.find((t) => t.id !== currentId) ?? null
  let roll = Math.random() * total
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return pool[i]
  }
  return pool[pool.length - 1]
}

// A few links close to `origin`, used to simulate "links found on this page".
export function nearbyTargets(targets, origin, radius, limit) {
  const close = targets
    .filter((t) => t.id !== origin.id)
    .map((t) => ({ t, d: Math.hypot(t.cx - origin.cx, t.cy - origin.cy) }))
    .filter((entry) => entry.d <= radius)
    .sort((p, q) => p.d - q.d)
    .slice(0, limit * 2)
    .sort(() => Math.random() - 0.5)
    .slice(0, limit)
  return close.map((entry) => entry.t)
}