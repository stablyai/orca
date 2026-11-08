import { useEffect, useState } from 'react'
import type { FloatingWorkspaceWindowSnapshot } from '../../../../shared/floating-workspace-window'

/** Follow the main renderer's published snapshot; null until the first one arrives. */
export function useFloatingWorkspaceWindowSnapshot(): FloatingWorkspaceWindowSnapshot | null {
  const [snapshot, setSnapshot] = useState<FloatingWorkspaceWindowSnapshot | null>(null)

  useEffect(() => {
    const api = window.api.floatingWorkspaceWindow
    let disposed = false
    const unsubscribe = api.onSnapshot(setSnapshot)
    // Why: a push that landed first is newer than the cached reply.
    void api
      .requestSnapshot()
      .then((cached) => {
        if (!disposed && cached) {
          setSnapshot((current) => current ?? cached)
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return snapshot
}
