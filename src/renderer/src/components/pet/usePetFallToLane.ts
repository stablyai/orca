import { useCallback, useEffect, useRef, useState } from 'react'
import { advancePetFall, PET_FALL, type PetFallState } from './pet-fall-physics'
import { petWalkBounds } from './pet-walk-lane'

/** How long the landing squash plays before the idle bob takes over again. */
export const PET_LANDING_SQUASH_MS = 220
/** Beat spent flat on its back before it starts pushing itself up. */
export const PET_DOWNED_MS = 520
/** Deliberately unhurried — the pet has just been dropped from a height. */
export const PET_RISING_MS = 1200
/** Under this a drop is a stumble; the quick squash reads better than a topple. */
export const PET_SUPINE_MIN_DROP_PX = 80

type PetFallPhase = 'none' | 'falling' | 'landing' | 'downed' | 'rising'

type PetFallOptions = {
  size: number
  laneY: number
  readPosition: () => { x: number; y: number }
  onAdvance: (x: number, y: number) => void
}

export type PetFallControl = {
  falling: boolean
  landing: boolean
  /** Toppled onto its back: airborne after a real drop, or lying on the lane. */
  supine: boolean
  rising: boolean
  /** True while the pet is in no state to walk. */
  busy: boolean
  start: (velocity: { vx: number; vy: number }) => void
  cancel: () => void
}

export function usePetFallToLane({
  size,
  laneY,
  readPosition,
  onAdvance
}: PetFallOptions): PetFallControl {
  const [phase, setPhase] = useState<PetFallPhase>('none')
  const velocityRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 })
  // Why: decided at release, not at impact — by the time it lands the pet is
  // already at lane height and the drop it survived is no longer measurable.
  const onBackRef = useRef(false)
  const readPositionRef = useRef(readPosition)
  const onAdvanceRef = useRef(onAdvance)
  // Why: the loop reads the lane and size through refs so a resize cannot
  // restart it. A restart drops the timestamp baseline, and the tick after one
  // only records — a stream of them would leave the pet hanging in mid-air.
  const laneYRef = useRef(laneY)
  const sizeRef = useRef(size)
  // Why: written after commit, not during render. React may replay or discard a
  // render, and a ref written in one that never commits would feed the loop a
  // value the user never saw.
  useEffect(() => {
    readPositionRef.current = readPosition
    onAdvanceRef.current = onAdvance
    laneYRef.current = laneY
    sizeRef.current = size
  })

  const start = useCallback(
    (velocity: { vx: number; vy: number }) => {
      velocityRef.current = velocity
      onBackRef.current = laneY - readPositionRef.current().y >= PET_SUPINE_MIN_DROP_PX
      setPhase('falling')
    },
    [laneY]
  )

  const cancel = useCallback(() => {
    velocityRef.current = { vx: 0, vy: 0 }
    onBackRef.current = false
    setPhase('none')
  }, [])

  useEffect(() => {
    const next: Partial<Record<PetFallPhase, { to: PetFallPhase; after: number }>> = {
      landing: { to: 'none', after: PET_LANDING_SQUASH_MS },
      downed: { to: 'rising', after: PET_DOWNED_MS },
      rising: { to: 'none', after: PET_RISING_MS }
    }
    const step = next[phase]
    if (!step) {
      return
    }
    const timer = setTimeout(() => setPhase(step.to), step.after)
    return () => clearTimeout(timer)
  }, [phase])

  useEffect(() => {
    if (phase !== 'falling') {
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
          laneY: laneYRef.current,
          ...petWalkBounds(window.innerWidth, sizeRef.current)
        })
        velocityRef.current = { vx: next.vx, vy: next.vy }
        onAdvanceRef.current(next.x, next.y)
        if (next.landed) {
          setPhase(onBackRef.current ? 'downed' : 'landing')
          return
        }
      }
      previousTimestamp = timestamp
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])

  const supine = (phase === 'falling' && onBackRef.current) || phase === 'downed'
  return {
    falling: phase === 'falling',
    landing: phase === 'landing',
    supine,
    rising: phase === 'rising',
    busy: phase === 'falling' || phase === 'downed' || phase === 'rising',
    start,
    cancel
  }
}
