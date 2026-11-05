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

export function recordPaneUse(
  worktreeId: string,
  entityId: string,
  tabsByWorkspace: () => Readonly<Record<string, readonly Tab[]>>
): void {
  const uses = useAtByWorkspace.get(worktreeId)
  // Why: only a tab's first use scans for closed tabs; repeated clicks and keys stay O(1).
  if (!uses?.has(entityId)) {
    prune(tabsByWorkspace())
  }
  const current = useAtByWorkspace.get(worktreeId) ?? new Map<string, number>()
  current.set(entityId, Date.now())
  useAtByWorkspace.set(worktreeId, current)
}

export function paneUseAt(worktreeId: string, entityId: string): number | undefined {
  return useAtByWorkspace.get(worktreeId)?.get(entityId)
}

export function clearPaneUseForTests(): void {
  useAtByWorkspace.clear()
}
