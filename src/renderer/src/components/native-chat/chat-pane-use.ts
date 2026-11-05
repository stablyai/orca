// Clicks and typing in a chat or terminal pane this session; a tab's saved time only records activations.
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'

type TabsByWorkspace = Readonly<Record<string, readonly Tab[]>>

const useAtByWorkspace = new Map<string, Map<string, number>>()
let stopWatchingTabs: (() => void) | null = null

/** Drops records of tabs a workspace no longer holds; a hidden tab is still open. */
function retireClosedTabs(tabs: TabsByWorkspace, previous: TabsByWorkspace): void {
  for (const [worktreeId, uses] of useAtByWorkspace) {
    const workspaceTabs = tabs[worktreeId]
    if (workspaceTabs === previous[worktreeId]) {
      continue
    }
    const live = new Set((workspaceTabs ?? []).map((tab) => tab.entityId))
    for (const entityId of uses.keys()) {
      if (!live.has(entityId)) {
        uses.delete(entityId)
      }
    }
    if (uses.size === 0) {
      useAtByWorkspace.delete(worktreeId)
    }
  }
  if (useAtByWorkspace.size === 0) {
    stopWatchingTabs?.()
    stopWatchingTabs = null
  }
}

// Why: records retire when the tab list itself changes, so a click or key never scans tabs and
// closed tabs leave no records behind even if the user never adds a selection.
function watchTabsWhileRecording(): void {
  stopWatchingTabs ??= useAppStore.subscribe((state, previous) => {
    if (state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree) {
      retireClosedTabs(state.unifiedTabsByWorktree, previous.unifiedTabsByWorktree)
    }
  })
}

export function recordPaneUse(worktreeId: string, entityId: string): void {
  const uses = useAtByWorkspace.get(worktreeId) ?? new Map<string, number>()
  uses.set(entityId, Date.now())
  useAtByWorkspace.set(worktreeId, uses)
  watchTabsWhileRecording()
}

export function readPaneUse(worktreeId: string, entityId: string): number | undefined {
  return useAtByWorkspace.get(worktreeId)?.get(entityId)
}

export function paneUseRecordCountForTests(): number {
  let count = 0
  for (const uses of useAtByWorkspace.values()) {
    count += uses.size
  }
  return count
}

export function isWatchingTabsForTests(): boolean {
  return stopWatchingTabs !== null
}

export function clearPaneUseForTests(): void {
  useAtByWorkspace.clear()
  stopWatchingTabs?.()
  stopWatchingTabs = null
}
