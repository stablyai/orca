import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { nextPetDragAnimation, type PetDragAnimation } from './pet-agent-state'

type Point = { x: number; y: number }

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

/** Where drag coordinates are measured. The in-window overlay positions itself against the
 *  viewport ('client'); the detached pet window moves the OS window itself, whose own motion
 *  cancels out client coordinates, so it reads desktop coordinates instead. */
export type PetPointerCoordinateSpace = 'client' | 'screen'

function readPointerPoint(
  event: ReactPointerEvent<HTMLDivElement>,
  space: PetPointerCoordinateSpace
): Point {
  return space === 'screen'
    ? { x: event.screenX, y: event.screenY }
    : { x: event.clientX, y: event.clientY }
}

// Drag/hover state for the pet overlay. `position` is the overlay's current
// top-left corner — pass a getter when the pet moves without re-rendering (the detached
// window moves itself) — and `moveTo` receives the unclamped position the drag wants.
export function usePetPointerInteraction(
  position: Point | (() => Point),
  moveTo: (next: Point) => void,
  coordinateSpace: PetPointerCoordinateSpace = 'client'
): PetPointerInteraction {
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
    const point = readPointerPoint(event, coordinateSpace)
    const origin = typeof position === 'function' ? position() : position
    dragOffsetRef.current = {
      x: point.x - origin.x,
      y: point.y - origin.y
    }
    dragBaselineXRef.current = point.x
    dragDirectionRef.current = null
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
    const point = readPointerPoint(event, coordinateSpace)
    const next = nextPetDragAnimation(dragDirectionRef.current, point.x - dragBaselineXRef.current)
    if (next.accepted) {
      dragBaselineXRef.current = point.x
      if (next.animation !== dragDirectionRef.current) {
        dragDirectionRef.current = next.animation
        setDragAnimation(next.animation)
      }
    }
    moveTo({
      x: point.x - dragOffsetRef.current.x,
      y: point.y - dragOffsetRef.current.y
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
