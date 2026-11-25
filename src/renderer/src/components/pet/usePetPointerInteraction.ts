import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { nextPetDragAnimation, type PetDragAnimation } from './pet-agent-state'

type Point = { x: number; y: number }

export type PetPointerInteraction = {
  dragging: boolean
  dragAnimation: PetDragAnimation
  hovering: boolean
  // Grab generation restarts sprite playback at frame 0.
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

// moveTo receives the desired unclamped overlay position.
export function usePetPointerInteraction(
  position: Point,
  moveTo: (next: Point) => void
): PetPointerInteraction {
  const [dragging, setDragging] = useState(false)
  const [dragAnimation, setDragAnimation] = useState<PetDragAnimation>(null)
  const [hovering, setHovering] = useState(false)
  const [dragGeneration, setDragGeneration] = useState(0)
  const dragOffsetRef = useRef<Point>({ x: 0, y: 0 })
  // Advance horizontal hysteresis only on accepted direction changes; keep it separate from position anchors.
  const dragBaselineXRef = useRef(0)
  // Read/write refs in handlers so batched moves cannot resurrect a stale direction.
  const dragDirectionRef = useRef<PetDragAnimation>(null)
  const activePointerRef = useRef<number | null>(null)

  // Capture pointer events beyond the window so outside releases cannot leave dragging stuck.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Accept one primary-button pointer so additional touches cannot replace active anchors.
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
      // Capture may be revoked without pointerup; end the drag then too.
      onLostPointerCapture: endDrag,
      onPointerEnter: () => setHovering(true),
      onPointerLeave: () => setHovering(false)
    }
  }
}
