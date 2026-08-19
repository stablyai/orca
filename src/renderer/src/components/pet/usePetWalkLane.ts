import { useEffect, useRef, useState } from 'react'
import {
  advancePetWalk,
  petWalkBounds,
  PET_WALK_SPEED_PX_PER_SEC,
  type PetWalkDirection
} from './pet-walk-lane'

type PetWalkLaneOptions = {
  /** False while dragging, hidden, or under reduced motion — the pet holds still. */
  active: boolean
  size: number
  readX: () => number
  onAdvance: (x: number) => void
}

/** Drives the pet's horizontal pacing and reports which way it currently faces. */
export function usePetWalkLane({
  active,
  size,
  readX,
  onAdvance
}: PetWalkLaneOptions): PetWalkDirection {
  const [direction, setDirection] = useState<PetWalkDirection>('right')
  // Why: refs keep the rAF effect from restarting on every render — a restart
  // would drop the timestamp baseline and stall the walk at one frame per render.
  const directionRef = useRef<PetWalkDirection>('right')
  const readXRef = useRef(readX)
  const onAdvanceRef = useRef(onAdvance)
  // Why: size rides a ref for the same reason as the callbacks — resizing the
  // pet from the menu must not restart the loop and drop its timestamp baseline.
  const sizeRef = useRef(size)
  readXRef.current = readX
  onAdvanceRef.current = onAdvance
  sizeRef.current = size

  useEffect(() => {
    if (!active) {
      return
    }
    let previousTimestamp: number | null = null
    let frame = requestAnimationFrame(function tick(timestamp: number): void {
      if (previousTimestamp !== null) {
        const next = advancePetWalk(
          { x: readXRef.current(), direction: directionRef.current },
          {
            deltaMs: timestamp - previousTimestamp,
            speedPxPerSec: PET_WALK_SPEED_PX_PER_SEC,
            ...petWalkBounds(window.innerWidth, sizeRef.current)
          }
        )
        if (next.direction !== directionRef.current) {
          directionRef.current = next.direction
          setDirection(next.direction)
        }
        onAdvanceRef.current(next.x)
      }
      previousTimestamp = timestamp
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  return direction
}
