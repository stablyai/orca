import { useCallback, useEffect, useRef, useState } from 'react'
import { advancePetFall, PET_FALL, type PetFallState } from './pet-fall-physics'
import { petWalkBounds } from './pet-walk-lane'

/** How long the landing squash plays before the idle bob takes over again. */
export const PET_LANDING_SQUASH_MS = 220

type PetFallOptions = {
  size: number
  laneY: number
  readPosition: () => { x: number; y: number }
  onAdvance: (x: number, y: number) => void
}

export type PetFallControl = {
  falling: boolean
  landing: boolean
  /** Begin a drop from the current position, seeded with the throw velocity. */
  start: (velocity: { vx: number; vy: number }) => void
  cancel: () => void
}

export function usePetFallToLane({
  size,
  laneY,
  readPosition,
  onAdvance
}: PetFallOptions): PetFallControl {
  const [falling, setFalling] = useState(false)
  const [landing, setLanding] = useState(false)
  const velocityRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 })
  const readPositionRef = useRef(readPosition)
  const onAdvanceRef = useRef(onAdvance)
  readPositionRef.current = readPosition
  onAdvanceRef.current = onAdvance

  const start = useCallback((velocity: { vx: number; vy: number }) => {
    velocityRef.current = velocity
    setFalling(true)
  }, [])

  const cancel = useCallback(() => {
    velocityRef.current = { vx: 0, vy: 0 }
    setFalling(false)
  }, [])

  useEffect(() => {
    if (!landing) {
      return
    }
    const timer = setTimeout(() => setLanding(false), PET_LANDING_SQUASH_MS)
    return () => clearTimeout(timer)
  }, [landing])

  useEffect(() => {
    if (!falling) {
      return
    }
    let previousTimestamp: number | null = null
    let frame = requestAnimationFrame(function tick(timestamp: number): void {
      if (previousTimestamp !== null) {
        const { x, y } = readPositionRef.current()
        const state: PetFallState = { x, y, ...velocityRef.current }
        const next = advancePetFall(state, {
          ...PET_FALL,
          // Why: a long frame (backgrounded window) would otherwise integrate one
          // huge step and teleport the pet through the lane.
          deltaMs: Math.min(timestamp - previousTimestamp, 50),
          laneY,
          ...petWalkBounds(window.innerWidth, size)
        })
        velocityRef.current = { vx: next.vx, vy: next.vy }
        onAdvanceRef.current(next.x, next.y)
        if (next.landed) {
          setFalling(false)
          setLanding(true)
          return
        }
      }
      previousTimestamp = timestamp
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [falling, laneY, size])

  return { falling, landing, start, cancel }
}
