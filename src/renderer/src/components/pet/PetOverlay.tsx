import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../../store'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { PET_SIZE_DEFAULT } from '../../../../shared/pet-types'
import {
  selectPetAnimationName,
  type PetAnimationName,
  type PetDragAnimation
} from './pet-agent-state'
import { PetCharacter } from './PetCharacter'
import { usePetPointerInteraction } from './usePetPointerInteraction'

function usePetAnimationName(
  dragging: boolean,
  dragAnimation: PetDragAnimation,
  hovering: boolean
): PetAnimationName {
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)

  // Re-render when the freshness scheduler ticks so stale live states stop
  // driving pet animations even if no other store value changes.
  void agentStatusEpoch

  return selectPetAnimationName({
    entries: Object.values(agentStatusByPaneKey),
    retainedCount: Object.keys(retainedAgentsByPaneKey).length,
    dragging,
    dragAnimation,
    hovering,
    now: Date.now(),
    staleAfterMs: AGENT_STATUS_STALE_AFTER_MS
  })
}

// Why: keep a default for the cached helpers below; the live size now comes
// from the store so the user can resize from the status-bar menu.
const SIZE = PET_SIZE_DEFAULT
const POSITION_STORAGE_KEY = 'pet-overlay-position'
const LEGACY_POSITION_STORAGE_KEY = 'sidekick-overlay-position'

export type Position = { x: number; y: number }

export function clampPositionToViewport(
  pos: Position,
  size: number,
  viewport: { width: number; height: number }
): Position {
  const maxX = Math.max(0, viewport.width - size)
  const maxY = Math.max(0, viewport.height - size)
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY)
  }
}

function clampToViewport(pos: Position, size: number = SIZE): Position {
  if (typeof window === 'undefined') {
    return pos
  }
  return clampPositionToViewport(pos, size, {
    width: window.innerWidth,
    height: window.innerHeight
  })
}

function loadStoredPosition(size: number = SIZE): Position | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    let raw = window.localStorage.getItem(POSITION_STORAGE_KEY)
    let migratedFromLegacy = false
    if (!raw) {
      raw = window.localStorage.getItem(LEGACY_POSITION_STORAGE_KEY)
      if (!raw) {
        return null
      }
      migratedFromLegacy = true
    }
    const parsed = JSON.parse(raw) as Partial<Position>
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
      return null
    }
    if (migratedFromLegacy) {
      try {
        window.localStorage.setItem(POSITION_STORAGE_KEY, raw)
      } catch {
        // ignore storage failures
      }
    }
    // Why: clamp using the live overlay size so a persisted position from a
    // larger overlay doesn't slip off the bottom/right edge after a shrink.
    return clampToViewport({ x: parsed.x, y: parsed.y }, size)
  } catch {
    return null
  }
}

function defaultPosition(size: number = SIZE): Position {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0 }
  }
  // Matches previous bottom-4 right-16 (right: 4rem, bottom: 1rem).
  return clampToViewport(
    {
      x: window.innerWidth - size - 64,
      y: window.innerHeight - size - 16
    },
    size
  )
}

export function PetOverlay(): React.JSX.Element {
  const size = useAppStore((s) => s.petSize)

  const [positionState, setPositionState] = useState<{
    size: number
    position: Position
  }>(() => {
    // Why: read the persisted size eagerly via getState so the initial clamp
    // uses the user's last pet size — useState's lazy initializer runs
    // before the `size` prop binding settles, and `loadStoredPosition` would
    // otherwise default to SIZE and clip a previously-saved position.
    const currentSize = useAppStore.getState().petSize ?? SIZE
    return {
      size: currentSize,
      position: loadStoredPosition(currentSize) ?? defaultPosition(currentSize)
    }
  })
  let position = positionState.position
  if (positionState.size !== size) {
    position = clampToViewport(positionState.position, size)
    setPositionState({ size, position })
  }
  const setPosition = useCallback(
    (nextPosition: Position | ((current: Position) => Position)): void => {
      setPositionState((current) => {
        const currentPosition =
          current.size === size ? current.position : clampToViewport(current.position, size)
        return {
          size,
          position:
            typeof nextPosition === 'function' ? nextPosition(currentPosition) : nextPosition
        }
      })
    },
    [size]
  )
  const interaction = usePetPointerInteraction(position, (next) =>
    setPosition(clampToViewport(next, size))
  )
  const { dragging, dragAnimation, hovering } = interaction

  useEffect(() => {
    const onResize = (): void => setPosition((prev) => clampToViewport(prev, size))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setPosition, size])

  useEffect(() => {
    if (dragging) {
      return
    }
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position))
    } catch {
      // ignore storage failures
    }
  }, [dragging, position])

  const animationName = usePetAnimationName(dragging, dragAnimation, hovering)

  return (
    // Why: the outer box and middle layer stay pointer-events-none so app chrome
    // stays interactive; only the innermost wrapper opts in and shrink-wraps its
    // content, so the grab/drag hit area hugs the pet, not the full square box.
    <div
      aria-hidden
      className="pointer-events-none fixed z-40"
      style={{
        left: position.x,
        top: position.y,
        width: size,
        height: size
      }}
    >
      <div className="pointer-events-none flex size-full items-center justify-end">
        <PetCharacter
          size={size}
          animationName={animationName}
          interaction={interaction}
          className="pointer-events-auto"
        />
      </div>
    </div>
  )
}

export default PetOverlay
