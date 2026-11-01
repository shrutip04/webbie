// The crawler body: a head that steers continuously + eight legs that take steps.
// Pure simulation, no drawing and no DOM.

export const TRAIL_LIFE = 1.2 // seconds a trail point stays visible

const CRUISE_SPEED = 130   // px/s while walking (the UI speed slider scales time itself)
const TURN_RATE = 3.2      // rad/s the heading may change
const STEP_TIME = 0.16     // seconds a foot spends in the air
const STEP_THRESHOLD = 24  // px a planted foot may lag behind its rest spot before stepping
const L1 = 34              // upper leg length
const L2 = 42              // lower leg length

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))

// Where each leg wants its foot, relative to the body (along = forward, out = sideways).
const SLOTS = [
  { along: 30, out: 52 },
  { along: 10, out: 62 },
  { along: -12, out: 62 },
  { along: -32, out: 52 },
]

function bodyAxes(body) {
  const fx = Math.cos(body.heading)
  const fy = Math.sin(body.heading)
  return { fx, fy, sx: -fy, sy: fx }
}

function restPosition(body, leg) {
  const { fx, fy, sx, sy } = bodyAxes(body)
  return {
    x: body.x + fx * leg.along + sx * leg.out * leg.side,
    y: body.y + fy * leg.along + sy * leg.out * leg.side,
  }
}

export function createCrawlerBody(x, y, heading = 0) {
  const body = {
    x,
    y,
    heading,
    speed: 0,
    vx: 0,
    vy: 0,
    seed: Math.random() * Math.PI * 2,
    legs: [],
    trail: [],
  }

  for (const side of [1, -1]) {
    SLOTS.forEach((slot, i) => {
      const leg = {
        side,
        // Alternating gait: legs are split into two groups that take turns stepping.
        group: (i + (side > 0 ? 0 : 1)) % 2,
        along: slot.along * (0.9 + Math.random() * 0.2),
        out: slot.out * (0.9 + Math.random() * 0.2),
        fx: 0, fy: 0,                // planted/foot position (world)
        stepping: false,
        stepT: 0,
        fromX: 0, fromY: 0, toX: 0, toY: 0,
        hipX: 0, hipY: 0, kneeX: 0, kneeY: 0,
      }
      const rest = restPosition(body, leg)
      leg.fx = rest.x
      leg.fy = rest.y
      body.legs.push(leg)
    })
  }
  updateLegs(body, 0, 0) // fill in hip/knee positions
  return body
}

// Turn toward the target and move forward. No easing between "stops": the body keeps walking.
export function steer(body, target, dt, clock, boost = 1) {
  const dx = target.cx - body.x
  const dy = target.cy - body.y
  const distance = Math.hypot(dx, dy)

  const diff = wrapAngle(Math.atan2(dy, dx) - body.heading)
  const maxTurn = TURN_RATE * (distance < 70 ? 2.5 : 1) * dt // turn harder when close, so it never orbits
  body.heading += clamp(diff, -maxTurn, maxTurn)
  body.heading += Math.sin(clock * 2.1 + body.seed) * 0.35 * dt // slight organic wobble

  const wanted = CRUISE_SPEED * boost * clamp(distance / 90, 0.45, 1) // slow down near a link, never stop
  body.speed += (wanted - body.speed) * (1 - Math.exp(-dt * 4))
  body.vx = Math.cos(body.heading) * body.speed
  body.vy = Math.sin(body.heading) * body.speed
  body.x += body.vx * dt
  body.y += body.vy * dt
}

export function updateLegs(body, dt, clock, onPlant) {
  const groupBusy = [false, false]
  for (const leg of body.legs) if (leg.stepping) groupBusy[leg.group] = true

  for (const leg of body.legs) {
    const rest = restPosition(body, leg)

    if (leg.stepping) {
      leg.stepT += dt / STEP_TIME
      const t = Math.min(1, leg.stepT)
      const eased = 1 - (1 - t) * (1 - t)
      leg.fx = leg.fromX + (leg.toX - leg.fromX) * eased
      leg.fy = leg.fromY + (leg.toY - leg.fromY) * eased
      if (t >= 1) {
        leg.stepping = false
        if (onPlant) onPlant(leg, leg.fx, leg.fy)
      }
    } else {
      const stretch = Math.hypot(leg.fx - rest.x, leg.fy - rest.y)
      const otherGroupBusy = groupBusy[1 - leg.group]
      // Normal rule: step when stretched and the other group is not mid-step.
      // Emergency rule: a badly over-stretched foot steps anyway.
      if ((stretch > STEP_THRESHOLD && !otherGroupBusy) || stretch > STEP_THRESHOLD * 1.8) {
        const lead = STEP_TIME * 1.2 // aim slightly ahead of where the body is going
        leg.stepping = true
        leg.stepT = 0
        leg.fromX = leg.fx
        leg.fromY = leg.fy
        leg.toX = rest.x + body.vx * lead + (Math.random() - 0.5) * 6
        leg.toY = rest.y + body.vy * lead + (Math.random() - 0.5) * 6
        groupBusy[leg.group] = true
      }
    }
    solveLeg(body, leg)
  }
}

// Two-bone inverse kinematics: find the knee so hip→knee→foot has fixed segment lengths.
function solveLeg(body, leg) {
  const { fx, fy, sx, sy } = bodyAxes(body)
  leg.hipX = body.x + fx * leg.along * 0.35 + sx * 5 * leg.side
  leg.hipY = body.y + fy * leg.along * 0.35 + sy * 5 * leg.side

  const dx = leg.fx - leg.hipX
  const dy = leg.fy - leg.hipY
  const distance = Math.hypot(dx, dy) || 0.001
  const reach = Math.min(distance, L1 + L2 - 0.5)
  const ux = dx / distance
  const uy = dy / distance

  const along = (L1 * L1 - L2 * L2 + reach * reach) / (2 * reach)
  const height = Math.sqrt(Math.max(0, L1 * L1 - along * along))

  // Bend the knee away from the body.
  let px = -uy
  let py = ux
  if (px * sx * leg.side + py * sy * leg.side < 0) {
    px = -px
    py = -py
  }
  leg.kneeX = leg.hipX + ux * along + px * height
  leg.kneeY = leg.hipY + uy * along + py * height
}

export function updateTrail(body, clock) {
  const last = body.trail[body.trail.length - 1]
  if (!last || Math.hypot(body.x - last.x, body.y - last.y) > 3) {
    body.trail.push({ x: body.x, y: body.y, t: clock })
  }
  while (body.trail.length && clock - body.trail[0].t > TRAIL_LIFE) body.trail.shift()
}