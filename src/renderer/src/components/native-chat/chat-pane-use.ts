// Clicks and typing in a chat or terminal pane this session; a tab's saved time only records activations.
import type { Tab } from '../../../../shared/tab-types'

type TabsByWorkspace = Readonly<Record<string, readonly Tab[]>>

const MIN_PRUNE_AT = 64
const useAtByWorkspace = new Map<string, Map<string, number>>()
let recordCount = 0
let pruneAt = MIN_PRUNE_AT

/** Keep only records of tabs that still exist; a hidden tab is still open. */
function prune(tabsByWorkspace: TabsByWorkspace): void {
  for (const [worktreeId, uses] of useAtByWorkspace) {
    const live = new Set((tabsByWorkspace[worktreeId] ?? []).map((tab) => tab.entityId))
    for (const entityId of uses.keys()) {
      if (!live.has(entityId)) {
        uses.delete(entityId)
        recordCount--
      }
    }
    if (uses.size === 0) {
      useAtByWorkspace.delete(worktreeId)
    }
  }
  // Why: the next prune waits until the records double, so a click or key costs O(1) on average
  // and records of closed tabs never outnumber twice the tabs still open.
  pruneAt = Math.max(MIN_PRUNE_AT, recordCount * 2)
}

export function recordPaneUse(
  worktreeId: string,
  entityId: string,
  tabsByWorkspace: () => TabsByWorkspace
): void {
  const uses = useAtByWorkspace.get(worktreeId) ?? new Map<string, number>()
  if (!uses.has(entityId)) {
    recordCount++
  }
  uses.set(entityId, Date.now())
  useAtByWorkspace.set(worktreeId, uses)
  if (recordCount > pruneAt) {
    prune(tabsByWorkspace())
  }
}

/** Reads one tab's use, after dropping records of tabs that no longer exist. */
export function readPaneUse(
  tabsByWorkspace: TabsByWorkspace
): (worktreeId: string, entityId: string) => number | undefined {
  prune(tabsByWorkspace)
  return (worktreeId, entityId) => useAtByWorkspace.get(worktreeId)?.get(entityId)
}

export function paneUseRecordCountForTests(): number {
  return recordCount
}

export function clearPaneUseForTests(): void {
  useAtByWorkspace.clear()
  recordCount = 0
  pruneAt = MIN_PRUNE_AT
}
