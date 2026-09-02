import { useCallback, useState, type RefObject } from 'react'

export type AgentMapPointerHold = {
  projectId: string | null
  worktreeId: string | null
}

type AgentMapPointerDragRef = RefObject<{ pointerId: number } | null>

function closestId(target: Element, attribute: string): string | null {
  return target.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null
}

/**
 * Remembers which rings a pan drag started in. Pointer capture retargets
 * `:hover` to the `<svg>` for the whole gesture, so the ring under the pointer
 * would otherwise collapse until the gesture ends.
 */
export function useAgentMapPointerHold(dragRef: AgentMapPointerDragRef): {
  held: AgentMapPointerHold | null
  hold: (target: Element) => void
  release: () => void
  clearDrag: (pointerId: number) => boolean
} {
  const [held, setHeld] = useState<AgentMapPointerHold | null>(null)
  const hold = useCallback((target: Element): void => {
    const projectId = closestId(target, 'data-agent-map-project-id')
    const worktreeId = closestId(target, 'data-agent-map-worktree-id')
    // A pan off empty canvas holds nothing, so leave the memoized scene alone.
    setHeld(projectId === null && worktreeId === null ? null : { projectId, worktreeId })
  }, [])
  const release = useCallback((): void => {
    setHeld((current) => (current === null ? current : null))
  }, [])
  const clearDrag = useCallback(
    (pointerId: number): boolean => {
      if (dragRef.current?.pointerId !== pointerId) {
        return false
      }
      dragRef.current = null
      release()
      return true
    },
    [dragRef, release]
  )
  return { held, hold, release, clearDrag }
}
