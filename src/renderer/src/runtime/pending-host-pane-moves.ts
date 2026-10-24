import { makePaneKey } from '../../../shared/stable-pane-id'

// Panes this window moved to a new tab whose host move has not settled, keyed by target pane key.
const pendingTargets = new Map<string, number>()

/** Marks a pane this window drew in its new tab before the host moved it; returns the release. */
export function beginPendingHostPaneMove(targetTabId: string, leafId: string): () => void {
  const key = makePaneKey(targetTabId, leafId)
  pendingTargets.set(key, (pendingTargets.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (pendingTargets.get(key) ?? 1) - 1
    if (remaining > 0) {
      pendingTargets.set(key, remaining)
    } else {
      pendingTargets.delete(key)
    }
  }
}

/** Whether a host snapshot may still predate this window's move of the pane into this tab. */
export function isPendingHostPaneMoveTarget(tabId: string, leafId: string): boolean {
  return pendingTargets.has(makePaneKey(tabId, leafId))
}
