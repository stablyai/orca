// Which terminal panes a workspace has, whether each is the one in front, and whether its
// transport is attached to a live terminal. A wake reports ready once the server answers, but the
// pane in front re-attaches to its terminal a moment later; the waking pill waits for that, so it
// never disappears over a pane that can't take a keystroke yet.

export type WakePaneEntry = {
  /** Attached to the woken terminal and taking input. */
  isReady: () => boolean
  /** The pane in front: its tab is the active, visible one and it is that tab's active pane. */
  isActive: () => boolean
}

const panes = new Map<string, Map<string, WakePaneEntry>>()

/** Registers a pane (keyed by its layout leaf, which outlives remounts); returns its removal. */
export function registerWakePane(
  workspaceId: string | null | undefined,
  paneKey: string,
  entry: WakePaneEntry
): () => void {
  if (!workspaceId) {
    return () => {}
  }
  const forWorkspace = panes.get(workspaceId) ?? new Map<string, WakePaneEntry>()
  forWorkspace.set(paneKey, entry)
  panes.set(workspaceId, forWorkspace)
  return () => {
    const current = panes.get(workspaceId)
    // A remount registered a newer entry under the same key: leave that one.
    if (current?.get(paneKey) === entry) {
      current.delete(paneKey)
      if (current.size === 0) {
        panes.delete(workspaceId)
      }
    }
  }
}

function safely(read: () => boolean): boolean {
  try {
    return read()
  } catch {
    return false
  }
}

/**
 * Is the pane in front of this workspace attached? `null` when no pane in front is known (nothing
 * mounted, or another tab type is showing): there is nothing to wait for.
 */
export function isActiveWakePaneAttached(workspaceId: string): boolean | null {
  const forWorkspace = panes.get(workspaceId)
  if (!forWorkspace) {
    return null
  }
  for (const entry of forWorkspace.values()) {
    if (safely(entry.isActive)) {
      return safely(entry.isReady)
    }
  }
  return null
}

/** Tests. */
export function resetWakePanesForTests(): void {
  panes.clear()
}
