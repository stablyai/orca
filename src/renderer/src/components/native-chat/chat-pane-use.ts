// Clicks and typing in a chat or terminal pane this session; a tab's saved time only records activations.
import type { Tab } from '../../../../shared/tab-types'

const useAtByWorkspace = new Map<string, Map<string, number>>()

/** Keep only records of tabs that still exist; a hidden tab is still open. */
function prune(tabsByWorkspace: Readonly<Record<string, readonly Tab[]>>): void {
  for (const [worktreeId, uses] of useAtByWorkspace) {
    const live = new Set((tabsByWorkspace[worktreeId] ?? []).map((tab) => tab.entityId))
    for (const entityId of uses.keys()) {
      if (!live.has(entityId)) {
        uses.delete(entityId)
      }
    }
    if (uses.size === 0) {
      useAtByWorkspace.delete(worktreeId)
    }
  }
}

/** O(1) per click or key; records of closed tabs go when the next selection is added. */
export function recordPaneUse(worktreeId: string, entityId: string): void {
  const uses = useAtByWorkspace.get(worktreeId) ?? new Map<string, number>()
  uses.set(entityId, Date.now())
  useAtByWorkspace.set(worktreeId, uses)
}

/** Reads one tab's use, after dropping records of tabs that no longer exist. */
export function readPaneUse(
  tabsByWorkspace: Readonly<Record<string, readonly Tab[]>>
): (worktreeId: string, entityId: string) => number | undefined {
  prune(tabsByWorkspace)
  return (worktreeId, entityId) => useAtByWorkspace.get(worktreeId)?.get(entityId)
}

export function clearPaneUseForTests(): void {
  useAtByWorkspace.clear()
}
