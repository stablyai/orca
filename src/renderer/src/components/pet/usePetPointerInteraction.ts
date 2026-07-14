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
    onPointerEnter: () => void
    onPointerLeave: () => void
  }
}

// Drag/hover state for the pet overlay. `position` is the overlay's current
// top-left corner and `moveTo` receives the unclamped position the drag wants.
export function usePetPointerInteraction(
  position: Point,
  moveTo: (next: Point) => void
): PetPointerInteraction {
  const [dragging, setDragging] = useState(false)
  const [dragAnimation, setDragAnimation] = useState<PetDragAnimation>(null)
  const [hovering, setHovering] = useState(false)
  const [dragGeneration, setDragGeneration] = useState(0)
  const dragOffsetRef = useRef<Point>({ x: 0, y: 0 })
  // Why: last accepted sample for the drag direction hysteresis. Kept separate
  // from dragOffsetRef, which anchors the overlay position math.
  const dragSampleRef = useRef<Point>({ x: 0, y: 0 })

  // Why: setPointerCapture routes subsequent pointer events to this element
  // even when the cursor leaves the OS window, so dragging can't get stuck in
  // the "true" state if the user releases outside the app.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return
    }
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y
    }
    dragSampleRef.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    setDragAnimation(null)
    setDragGeneration((generation) => generation + 1)
    event.preventDefault()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) {
      return
    }
    const next = nextPetDragAnimation(
      dragAnimation,
      event.clientX - dragSampleRef.current.x,
      event.clientY - dragSampleRef.current.y
    )
    if (next.accepted) {
      dragSampleRef.current = { x: event.clientX, y: event.clientY }
      setDragAnimation(next.animation)
    }
    moveTo({
      x: event.clientX - dragOffsetRef.current.x,
      y: event.clientY - dragOffsetRef.current.y
    })
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
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
      onPointerEnter: () => setHovering(true),
      onPointerLeave: () => setHovering(false)
    }
  }
}
