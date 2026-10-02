import { useEffect, useState } from 'react'
import { roomQueuePointInSquareBounds } from './room-queue-drag-targeting'

export function useRoomQueueIdleExpansion(input: {
  dragging: boolean
  resetKey: string
  squares: ReadonlyMap<string, HTMLElement>
}): { idleExpanded: boolean; expandIdle: () => void } {
  const { dragging, resetKey, squares } = input
  const [idleExpanded, setIdleExpanded] = useState(false)
  const [previousResetKey, setPreviousResetKey] = useState(resetKey)
  if (resetKey !== previousResetKey) {
    setPreviousResetKey(resetKey)
    setIdleExpanded(false)
  }

  useEffect(() => {
    if (!idleExpanded || dragging) {
      return
    }
    const collapseOutside = (event: PointerEvent): void => {
      if (
        event.button === 0 &&
        !roomQueuePointInSquareBounds({ x: event.clientX, y: event.clientY }, squares)
      ) {
        setIdleExpanded(false)
      }
    }
    document.addEventListener('pointerdown', collapseOutside, true)
    return () => document.removeEventListener('pointerdown', collapseOutside, true)
  }, [dragging, idleExpanded, squares])

  return { idleExpanded, expandIdle: () => setIdleExpanded(true) }
}
