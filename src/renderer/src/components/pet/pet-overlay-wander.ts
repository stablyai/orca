import { useEffect, useRef } from 'react'
import type { PetAnimationName } from './pet-agent-state'

export type PetWanderDirection = -1 | 1
export type PetWanderPosition = { x: number; y: number }
export type PetWanderBounds = { minX: number; maxX: number; minY: number; maxY: number }

export const PET_WANDER_SPEED_PX_PER_SECOND = 32
export const PET_WANDER_FRAME_INTERVAL_MS = 50
export const PET_WANDER_EDGE_MARGIN_PX = 16
// Why: Orca keeps persistent bottom chrome, so random targets should not park
// the pet directly on top of the status bar.
export const PET_WANDER_BOTTOM_RESERVED_PX = 40
export const PET_WANDER_MAX_VERTICAL_TARGET_DELTA_PX = 120
export const PET_WANDER_TARGET_REACHED_DISTANCE_PX = 4
export const PET_WANDER_PAUSE_MIN_MS = 1_000
export const PET_WANDER_PAUSE_MAX_MS = 3_000

export function shouldPetWander({
  enabled,
  documentVisible,
  reducedMotion,
  dragging,
  animationName
}: {
  enabled: boolean
  documentVisible: boolean
  reducedMotion: boolean
  dragging: boolean
  animationName: PetAnimationName
}): boolean {
  return enabled && documentVisible && !reducedMotion && !dragging && animationName === 'idle'
}

export function getPetWanderAnimationName(
  animationName: PetAnimationName,
  moving: boolean,
  direction: PetWanderDirection
): PetAnimationName {
  if (!moving) {
    return animationName
  }
  return direction > 0 ? 'running-right' : 'running-left'
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function randomInRange(min: number, max: number, random: () => number): number {
  return min + (max - min) * random()
}

function isPositionInsideBounds(position: PetWanderPosition, bounds: PetWanderBounds): boolean {
  return (
    position.x >= bounds.minX &&
    position.x <= bounds.maxX &&
    position.y >= bounds.minY &&
    position.y <= bounds.maxY
  )
}

export function getPetWanderBounds({
  size,
  viewport
}: {
  size: number
  viewport: { width: number; height: number }
}): PetWanderBounds {
  const viewportMaxX = Math.max(0, viewport.width - size)
  const viewportMaxY = Math.max(0, viewport.height - size)
  const minX = Math.min(PET_WANDER_EDGE_MARGIN_PX, viewportMaxX)
  const minY = Math.min(PET_WANDER_EDGE_MARGIN_PX, viewportMaxY)
  return {
    minX,
    maxX: Math.max(minX, viewportMaxX - PET_WANDER_EDGE_MARGIN_PX),
    minY,
    maxY: Math.max(minY, viewportMaxY - PET_WANDER_BOTTOM_RESERVED_PX)
  }
}

export function choosePetWanderTarget({
  position,
  size,
  viewport,
  random
}: {
  position: PetWanderPosition
  size: number
  viewport: { width: number; height: number }
  random: () => number
}): PetWanderPosition {
  const bounds = getPetWanderBounds({ size, viewport })
  const yMin = clampValue(
    position.y - PET_WANDER_MAX_VERTICAL_TARGET_DELTA_PX,
    bounds.minY,
    bounds.maxY
  )
  const yMax = clampValue(
    position.y + PET_WANDER_MAX_VERTICAL_TARGET_DELTA_PX,
    bounds.minY,
    bounds.maxY
  )
  return {
    x: randomInRange(bounds.minX, bounds.maxX, random),
    y: randomInRange(yMin, yMax, random)
  }
}

function choosePetWanderPauseMs(random: () => number): number {
  return randomInRange(PET_WANDER_PAUSE_MIN_MS, PET_WANDER_PAUSE_MAX_MS, random)
}

export function stepPetWanderPosition({
  position,
  target,
  pausedUntil,
  horizontalDirection,
  now,
  deltaMs,
  size,
  viewport,
  random
}: {
  position: PetWanderPosition
  target: PetWanderPosition | null
  pausedUntil: number
  horizontalDirection: PetWanderDirection
  now: number
  deltaMs: number
  size: number
  viewport: { width: number; height: number }
  random: () => number
}): {
  position: PetWanderPosition
  target: PetWanderPosition | null
  pausedUntil: number
  horizontalDirection: PetWanderDirection
} {
  if (target === null && now < pausedUntil) {
    return { position, target, pausedUntil, horizontalDirection }
  }

  const bounds = getPetWanderBounds({ size, viewport })
  const validTarget = target && isPositionInsideBounds(target, bounds) ? target : null
  const activeTarget = validTarget ?? choosePetWanderTarget({ position, size, viewport, random })
  const dx = activeTarget.x - position.x
  const dy = activeTarget.y - position.y
  const distanceToTarget = Math.hypot(dx, dy)
  const maxDistance = (PET_WANDER_SPEED_PX_PER_SECOND * Math.max(0, deltaMs)) / 1000
  const nextHorizontalDirection =
    Math.abs(dx) > PET_WANDER_TARGET_REACHED_DISTANCE_PX ? (dx > 0 ? 1 : -1) : horizontalDirection

  if (
    distanceToTarget <= PET_WANDER_TARGET_REACHED_DISTANCE_PX ||
    distanceToTarget <= maxDistance
  ) {
    return {
      position: activeTarget,
      target: null,
      pausedUntil: now + choosePetWanderPauseMs(random),
      horizontalDirection: nextHorizontalDirection
    }
  }

  const stepRatio = maxDistance / distanceToTarget
  return {
    position: {
      x: position.x + dx * stepRatio,
      y: position.y + dy * stepRatio
    },
    target: activeTarget,
    pausedUntil: 0,
    horizontalDirection: nextHorizontalDirection
  }
}

export function usePetWander({
  enabled,
  documentVisible,
  reducedMotion,
  dragging,
  animationName,
  position,
  size,
  setPosition
}: {
  enabled: boolean
  documentVisible: boolean
  reducedMotion: boolean
  dragging: boolean
  animationName: PetAnimationName
  position: PetWanderPosition
  size: number
  setPosition: (
    nextPosition: PetWanderPosition | ((currentPosition: PetWanderPosition) => PetWanderPosition)
  ) => void
}): { wandering: boolean; animationName: PetAnimationName } {
  const horizontalDirectionRef = useRef<PetWanderDirection>(-1)
  const lastFrameAtRef = useRef<number | null>(null)
  const targetRef = useRef<PetWanderPosition | null>(null)
  const pausedUntilRef = useRef(0)
  const positionRef = useRef(position)
  const wandering = shouldPetWander({
    enabled,
    documentVisible,
    reducedMotion,
    dragging,
    animationName
  })

  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => {
    if (!wandering || typeof window === 'undefined') {
      lastFrameAtRef.current = null
      targetRef.current = null
      pausedUntilRef.current = 0
      return
    }

    let frame = 0
    const tick = (now: number): void => {
      const lastFrameAt = lastFrameAtRef.current
      if (lastFrameAt === null) {
        lastFrameAtRef.current = now
        frame = requestAnimationFrame(tick)
        return
      }
      const deltaMs = now - lastFrameAt
      if (deltaMs >= PET_WANDER_FRAME_INTERVAL_MS) {
        lastFrameAtRef.current = now
        if (targetRef.current === null && now < pausedUntilRef.current) {
          frame = requestAnimationFrame(tick)
          return
        }
        const next = stepPetWanderPosition({
          position: positionRef.current,
          target: targetRef.current,
          pausedUntil: pausedUntilRef.current,
          horizontalDirection: horizontalDirectionRef.current,
          now,
          deltaMs,
          size,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight
          },
          random: Math.random
        })
        positionRef.current = next.position
        targetRef.current = next.target
        pausedUntilRef.current = next.pausedUntil
        horizontalDirectionRef.current = next.horizontalDirection
        setPosition(next.position)
      }
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [setPosition, size, wandering])

  return {
    wandering,
    animationName: getPetWanderAnimationName(
      animationName,
      wandering && targetRef.current !== null,
      horizontalDirectionRef.current
    )
  }
}
