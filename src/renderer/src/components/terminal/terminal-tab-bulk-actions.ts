import type { TabContentType } from '../../../../shared/types'
import { hasUnroutableTerminalWorktreeOwner } from '@/lib/terminal-worktree-route'
import { useAppStore } from '@/store'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'

const EDITOR_TAB_CONTENT_TYPES = new Set<TabContentType>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

type TerminalTabBulkActionState = ReturnType<typeof useAppStore.getState>

async function requestUserTerminalClose(tabId: string): Promise<void> {
  // Keep bulk actions behind the same pinned/archive/retirement boundary as a single-tab close.
  const { closeTerminalTabAsync } = await import('./terminal-tab-actions')
  await closeTerminalTabAsync(tabId)
}

function isPinnedVisibleTab(
  state: TerminalTabBulkActionState,
  worktreeId: string,
  visibleId: string
): boolean {
  return (
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => (tab.id === visibleId || tab.entityId === visibleId) && tab.isPinned
    ) ?? false
  )
}

export async function closeOtherTerminalTabs(
  tabId: string,
  activeWorktreeId: string | null
): Promise<void> {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  if (hasUnroutableTerminalWorktreeOwner(state, activeWorktreeId)) {
    return
  }
  const currentTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  state.setActiveTab(tabId)
  for (const tab of currentTabs) {
    if (tab.id === tabId || isPinnedVisibleTab(state, activeWorktreeId, tab.id)) {
      continue
    }
    try {
      await requestUserTerminalClose(tab.id)
    } catch {
      // The close boundary exposes retry feedback; independent tabs still proceed.
    }
  }
}

export async function closeTerminalTabsToRight(
  tabId: string,
  activeWorktreeId: string | null
): Promise<void> {
  if (!activeWorktreeId) {
    return
  }

  const state = useAppStore.getState()
  if (hasUnroutableTerminalWorktreeOwner(state, activeWorktreeId)) {
    return
  }
  const currentTerminalTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  const currentEditorFiles = state.openFiles.filter((file) => file.worktreeId === activeWorktreeId)
  const terminalIds = currentTerminalTabs.map((tab) => tab.id)
  const terminalIdSet = new Set(terminalIds)
  const orderedIds = reconcileTabOrder(
    state.tabBarOrderByWorktree[activeWorktreeId],
    terminalIds,
    currentEditorFiles.map((file) => file.id)
  )

  const index = orderedIds.indexOf(tabId)
  if (index === -1) {
    return
  }
  for (const id of orderedIds.slice(index + 1)) {
    if (isPinnedVisibleTab(state, activeWorktreeId, id)) {
      continue
    }
    if (terminalIdSet.has(id)) {
      try {
        await requestUserTerminalClose(id)
      } catch {
        // The close boundary exposes retry feedback; independent tabs still proceed.
      }
      continue
    }
    const unifiedTab = (state.unifiedTabsByWorktree?.[activeWorktreeId] ?? []).find(
      (tab) => tab.entityId === id && EDITOR_TAB_CONTENT_TYPES.has(tab.contentType)
    )
    if (!unifiedTab?.isPinned) {
      useAppStore.getState().closeFile(id)
    }
  }
}
