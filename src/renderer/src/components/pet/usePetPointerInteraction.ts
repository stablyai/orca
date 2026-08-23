import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { nextPetDragAnimation, type PetDragAnimation } from './pet-agent-state'

type Point = { x: number; y: number }

export type PetThrowVelocity = { vx: number; vy: number }

type PointerSample = Point & { t: number }

/** Beyond this gap the last movement is stale — the user held still, so letting
 *  go is a drop, not a throw. Mirrors Shimeji seeding Thrown from cursor.dx/dy
 *  only while the cursor is actually moving. */
const THROW_SAMPLE_MAX_AGE_MS = 120
/** Keeps a frantic flick from launching the pet across the screen. */
const THROW_MAX_PX_PER_SEC = 2500

function throwVelocityFrom(
  previous: PointerSample | null,
  last: PointerSample | null,
  releaseT: number
): PetThrowVelocity {
  if (!previous || !last) {
    return { vx: 0, vy: 0 }
  }
  const span = last.t - previous.t
  if (span <= 0 || releaseT - last.t > THROW_SAMPLE_MAX_AGE_MS) {
    return { vx: 0, vy: 0 }
  }
  const clamp = (v: number): number =>
    Math.max(-THROW_MAX_PX_PER_SEC, Math.min(THROW_MAX_PX_PER_SEC, v))
  return {
    vx: clamp(((last.x - previous.x) / span) * 1000),
    vy: clamp(((last.y - previous.y) / span) * 1000)
  }
}

export type PetPointerInteraction = {
  dragging: boolean
  dragAnimation: PetDragAnimation
  hovering: boolean
  // Why: bumped on grab so the sprite restarts from frame 0, aligned with the
  // Codex mascot.
  dragGeneration: number
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerEnter: () => void
    onPointerLeave: () => void
  }
}

// Drag/hover state for the pet overlay. `position` is the overlay's current
// top-left corner and `moveTo` receives the unclamped position the drag wants.
export function usePetPointerInteraction(
  position: Point,
  moveTo: (next: Point) => void,
  onRelease?: (velocity: PetThrowVelocity) => void
): PetPointerInteraction {
  const lastSampleRef = useRef<PointerSample | null>(null)
  const previousSampleRef = useRef<PointerSample | null>(null)
  const onReleaseRef = useRef(onRelease)
  // Why: written after commit, not during render. React may replay or discard a
  // render, and a ref written in one that never commits would feed the loop a
  // value the user never saw.
  useEffect(() => {
    onReleaseRef.current = onRelease
  })
  const [dragging, setDragging] = useState(false)
  const [dragAnimation, setDragAnimation] = useState<PetDragAnimation>(null)
  const [hovering, setHovering] = useState(false)
  const [dragGeneration, setDragGeneration] = useState(0)
  const dragOffsetRef = useRef<Point>({ x: 0, y: 0 })
  // Why: horizontal baseline for the drag-direction hysteresis, advanced only on
  // an accepted direction. Kept separate from dragOffsetRef (position math).
  const dragBaselineXRef = useRef(0)
  // Why: read+written inside handlers, so keep in refs immune to render batching
  // (state would let two coalesced moves resurrect a stale direction).
  const dragDirectionRef = useRef<PetDragAnimation>(null)
  const activePointerRef = useRef<number | null>(null)

  // Why: setPointerCapture routes subsequent pointer events to this element
  // even when the cursor leaves the OS window, so dragging can't get stuck in
  // the "true" state if the user releases outside the app.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Why: primary button only, and one pointer owns the drag — a second touch
    // must not hijack the anchors mid-drag.
    if (event.button !== 0 || activePointerRef.current !== null) {
      return
    }
    activePointerRef.current = event.pointerId
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y
    }
    dragBaselineXRef.current = event.clientX
    dragDirectionRef.current = null
    lastSampleRef.current = { x: event.clientX, y: event.clientY, t: event.timeStamp }
    previousSampleRef.current = null
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    setDragAnimation(null)
    setDragGeneration((generation) => generation + 1)
    event.preventDefault()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerId !== activePointerRef.current) {
      return
    }
    const next = nextPetDragAnimation(
      dragDirectionRef.current,
      event.clientX - dragBaselineXRef.current
    )
    if (next.accepted) {
      dragBaselineXRef.current = event.clientX
      if (next.animation !== dragDirectionRef.current) {
        dragDirectionRef.current = next.animation
        setDragAnimation(next.animation)
      }
    }
    previousSampleRef.current = lastSampleRef.current
    lastSampleRef.current = { x: event.clientX, y: event.clientY, t: event.timeStamp }
    moveTo({
      x: event.clientX - dragOffsetRef.current.x,
      y: event.clientY - dragOffsetRef.current.y
    })
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerId !== activePointerRef.current) {
      return
    }
    activePointerRef.current = null
    dragDirectionRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
    setDragAnimation(null)
    onReleaseRef.current?.(
      throwVelocityFrom(previousSampleRef.current, lastSampleRef.current, event.timeStamp)
    )
    lastSampleRef.current = null
    previousSampleRef.current = null
  }

  return {
    dragging,
    dragAnimation,
    hovering,
    dragGeneration,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      // Why: capture can be revoked without a pointerup (e.g. the element loses
      // it); treat that as the end of the drag so it can't wedge on.
      onLostPointerCapture: endDrag,
      onPointerEnter: () => setHovering(true),
      onPointerLeave: () => setHovering(false)
    }
  }
}
