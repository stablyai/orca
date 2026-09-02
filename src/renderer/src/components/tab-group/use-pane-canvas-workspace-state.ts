import { useCallback, useEffect, useState } from 'react'
import {
  reconcilePaneCanvasWorkspaceState,
  type PaneCanvasWorkspaceState
} from './pane-canvas-layout-state'
import {
  readPaneCanvasWorkspaceState,
  writePaneCanvasWorkspaceState
} from './pane-canvas-layout-storage'

type PaneCanvasStateUpdater = (current: PaneCanvasWorkspaceState) => PaneCanvasWorkspaceState

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function usePaneCanvasWorkspaceState({
  ownerKey,
  terminalTabIds,
  preserveMissingBounds = false
}: {
  ownerKey: string
  terminalTabIds: readonly string[]
  preserveMissingBounds?: boolean
}): {
  canvasState: PaneCanvasWorkspaceState
  updateCanvasState: (updater: PaneCanvasStateUpdater) => void
} {
  const terminalTabIdsKey = terminalTabIds.join('\0')
  const [canvasState, setCanvasState] = useState<PaneCanvasWorkspaceState>(() => {
    const storage = browserStorage()
    return storage
      ? readPaneCanvasWorkspaceState(storage, ownerKey, terminalTabIds, {
          preserveMissingBounds
        })
      : reconcilePaneCanvasWorkspaceState(
          {
            mode: 'split',
            boundsByTerminalTabId: {}
          },
          terminalTabIds,
          undefined,
          { preserveMissingBounds }
        )
  })

  useEffect(() => {
    const storage = browserStorage()
    const currentTerminalTabIds = terminalTabIdsKey ? terminalTabIdsKey.split('\0') : []
    setCanvasState((current) => {
      const reconciled = storage
        ? readPaneCanvasWorkspaceState(storage, ownerKey, currentTerminalTabIds, {
            preserveMissingBounds
          })
        : reconcilePaneCanvasWorkspaceState(current, currentTerminalTabIds, undefined, {
            preserveMissingBounds
          })
      if (storage) {
        writePaneCanvasWorkspaceState(storage, ownerKey, reconciled)
      }
      return reconciled
    })
  }, [ownerKey, preserveMissingBounds, terminalTabIdsKey])

  const updateCanvasState = useCallback(
    (updater: PaneCanvasStateUpdater) => {
      setCanvasState((current) => {
        // Do not reconcile here. A Canvas action can create a terminal tab and
        // assign its bounds in the same event, before React has rendered the
        // new terminalTabIds value. Reconciling against that stale list would drop
        // the new bounds and make the card jump to the default arrangement.
        // The terminalTabIds effect above performs reconciliation once the store and
        // render agree on the current layout.
        const next = updater(current)
        const storage = browserStorage()
        if (storage) {
          writePaneCanvasWorkspaceState(storage, ownerKey, next)
        }
        return next
      })
    },
    [ownerKey]
  )

  return { canvasState, updateCanvasState }
}
