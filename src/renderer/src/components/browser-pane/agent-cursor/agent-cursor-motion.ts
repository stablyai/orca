// Spring-driven agent cursor. Writes only transform/opacity/filter, runs on rAF
// while something moves, and stops the loop once every spring settles.
import {
  clamp,
  CURSOR_REST_HEADING_DEG,
  projectedProgress,
  samplePath,
  type CursorPoint
} from './agent-cursor-path'
import {
  HEADING,
  LEAN,
  POSITION,
  SQUASH_SPRING,
  STRETCH,
  Spring,
  VISIBILITY
} from './agent-cursor-spring'
import { planCursorMotion, type CursorMotion } from './agent-cursor-motion-plan'
import { createCursorElement, playPressRing, writeCursorFrame } from './agent-cursor-elements'

const STEP_S = 1 / 240
const MAX_FRAME_S = 1 / 15
const ARRIVED_PX = 0.85
const ARRIVED_SPEED = 12
const WOBBLE_S = 1.41
const WOBBLE_PERIOD_S = 0.66
const WOBBLE_DEG = 12.5
const SQUASH = 0.15
// The first move fades in at the target; the click waits until it reads as visible.
const APPEARED_VISIBILITY = 0.9
const IDLE_DIM_DELAY_MS = 1500
const IDLE_OPACITY = '0.5'

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t

export type AgentCursorController = {
  /** Moves to a point in layer px; `onArrived(sequence)` fires once it has landed. */
  moveTo: (target: CursorPoint, sequence: number) => void
  /** Plays the press ring at the cursor's tip. */
  press: () => void
  /** Fades in or out without moving. Hidden cursors snap to their next target. */
  setVisible: (visible: boolean) => void
  destroy: () => void
}

/** Builds the cursor inside `layer`, which must cover the page exactly. */
export function createAgentCursor(
  layer: HTMLElement,
  options: { onArrived: (sequence: number) => void; reducedMotion: () => boolean }
): AgentCursorController {
  const { cursor, glyph } = createCursorElement(layer)

  const x = new Spring(0, POSITION)
  const y = new Spring(0, POSITION)
  const heading = new Spring(CURSOR_REST_HEADING_DEG, HEADING)
  const stretch = new Spring(1, STRETCH)
  const lean = new Spring(0, LEAN)
  const squash = new Spring(1, SQUASH_SPRING)
  const visibility = new Spring(0, VISIBILITY)
  const springs = [x, y, heading, stretch, lean, squash, visibility]

  let point: CursorPoint = { x: 0, y: 0 }
  let squashAxisDeg = 0
  let motion: CursorMotion | null = null
  let pendingArrival: number | null = null
  let wobbleElapsed: number | null = null
  let frame: number | null = null
  let lastFrameAt = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  const setPosition = (target: CursorPoint): void => {
    x.snap(target.x)
    y.snap(target.y)
    point = { ...target }
  }

  const resetLeanAndSquash = (): void => {
    lean.snap(0)
    squash.snap(1)
    stretch.snap(1)
    squashAxisDeg = 0
  }

  const jumpTo = (target: CursorPoint): void => {
    motion = null
    setPosition(target)
    resetLeanAndSquash()
    heading.snap(CURSOR_REST_HEADING_DEG)
  }

  const markActive = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    glyph.style.opacity = '1'
  }

  const arrive = (): void => {
    if (pendingArrival === null) {
      return
    }
    const sequence = pendingArrival
    pendingArrival = null
    wobbleElapsed = options.reducedMotion() ? null : 0
    idleTimer = setTimeout(() => {
      glyph.style.opacity = IDLE_OPACITY
    }, IDLE_DIM_DELAY_MS)
    options.onArrived(sequence)
  }

  const render = (): void => {
    const wobble =
      wobbleElapsed === null
        ? 0
        : WOBBLE_DEG *
          Math.sin((wobbleElapsed / WOBBLE_PERIOD_S) * Math.PI * 2) *
          Math.sin(Math.min(1, wobbleElapsed / WOBBLE_S) * Math.PI)
    writeCursorFrame(cursor, {
      point,
      headingDeg: heading.value + lean.value + wobble,
      stretch: stretch.value,
      squash: squash.value,
      squashAxisDeg,
      shown: clamp(visibility.value, 0, 1)
    })
  }

  const advanceMotion = (dt: number): void => {
    const before = point
    if (!motion) {
      stretch.target = 1
      squash.target = 1
      lean.target = 0
    } else if (motion.mode === 'path') {
      motion.progress.tick(dt)
      const sample = samplePath(motion.path, motion.progress.value)
      x.target = sample.point.x
      y.target = sample.point.y
      heading.aimAngle(sample.heading)
    } else {
      x.target = motion.end.x
      y.target = motion.end.y
      heading.aimAngle(CURSOR_REST_HEADING_DEG)
    }
    x.tick(dt)
    y.tick(dt)
    heading.tick(dt)
    point = { x: x.value, y: y.value }
    if (motion?.mode === 'path') {
      const speed = Math.hypot(point.x - before.x, point.y - before.y) / dt
      stretch.target = clamp(1 - speed / 5500, 0.65, 1)
      const finished = motion.progress.value >= 0.999 && Math.abs(motion.progress.velocity) < 0.01
      if (finished && hasLanded(motion.end)) {
        setPosition(motion.end)
        heading.aimAngle(CURSOR_REST_HEADING_DEG)
        stretch.snap(1)
        motion = null
        arrive()
      }
    } else if (motion?.mode === 'scoot') {
      const travelled = projectedProgress(point, motion.start, motion.end)
      const swing = Math.sin(Math.min(1, travelled) * Math.PI)
      squash.target = lerp(1, 1 - SQUASH, swing)
      lean.target = motion.leanDeg * swing
      if (travelled >= 0.999 && hasLanded(motion.end)) {
        setPosition(motion.end)
        resetLeanAndSquash()
        motion = null
        arrive()
      }
    }
    stretch.tick(dt)
    lean.tick(dt)
    squash.tick(dt)
    visibility.tick(dt)
    if (wobbleElapsed !== null) {
      wobbleElapsed += dt
      if (wobbleElapsed >= WOBBLE_S) {
        wobbleElapsed = null
      }
    }
    if (motion === null && pendingArrival !== null && visibility.value >= APPEARED_VISIBILITY) {
      arrive()
    }
  }

  const hasLanded = (end: CursorPoint): boolean =>
    Math.hypot(point.x - end.x, point.y - end.y) <= ARRIVED_PX &&
    Math.abs(x.velocity) <= ARRIVED_SPEED &&
    Math.abs(y.velocity) <= ARRIVED_SPEED

  const isMoving = (): boolean =>
    motion !== null ||
    pendingArrival !== null ||
    wobbleElapsed !== null ||
    springs.some((spring) => !spring.settled() || spring.value !== spring.target)

  const loop = (now: number): void => {
    frame = null
    if (destroyed) {
      return
    }
    let remaining = Math.min(MAX_FRAME_S, Math.max(STEP_S, (now - lastFrameAt) / 1000))
    lastFrameAt = now
    while (remaining > 1e-6) {
      advanceMotion(STEP_S)
      remaining -= STEP_S
    }
    render()
    if (isMoving()) {
      frame = requestAnimationFrame(loop)
    }
  }

  const start = (): void => {
    if (frame === null && !destroyed) {
      lastFrameAt = performance.now()
      frame = requestAnimationFrame(loop)
    }
  }

  const finishInstantly = (sequence: number): void => {
    pendingArrival = sequence
    render()
    arrive()
  }

  render()

  return {
    moveTo(target, sequence) {
      markActive()
      wobbleElapsed = null
      const hidden = visibility.target === 0 && visibility.value < 0.001
      visibility.target = 1
      if (options.reducedMotion()) {
        jumpTo(target)
        visibility.snap(1)
        finishInstantly(sequence)
        return
      }
      if (hidden) {
        // Appear where the agent acts instead of flying in from a stale spot.
        jumpTo(target)
      } else {
        motion = planCursorMotion(point, target, {
          width: layer.clientWidth,
          height: layer.clientHeight
        })
        x.config = motion?.mode === 'path' ? motion.position : POSITION
        y.config = x.config
        squashAxisDeg = motion?.mode === 'scoot' ? motion.axisDeg : 0
      }
      pendingArrival = sequence
      start()
    },
    press() {
      markActive()
      playPressRing(layer, point, options.reducedMotion())
    },
    setVisible(visible) {
      visibility.target = visible ? 1 : 0
      if (!visible) {
        markActive()
        if (pendingArrival !== null) {
          arrive()
        }
      }
      if (options.reducedMotion()) {
        visibility.snap(visibility.target)
        render()
        return
      }
      start()
    },
    destroy() {
      destroyed = true
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      cursor.remove()
    }
  }
}
