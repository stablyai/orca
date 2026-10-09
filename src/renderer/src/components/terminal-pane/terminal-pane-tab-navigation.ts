import { getActiveTabNavOrder, type VisibleTabRef } from '@/components/tab-bar/group-tab-order'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'
import { paneIsCoveredByNativeChat } from './native-chat-covered-pane'
import { resolveNativeChatActiveLayoutLeafId } from '../native-chat/native-chat-leaf-routing'

type NavigationState = Parameters<typeof getActiveTabNavOrder>[0] &
  Pick<AppState, 'terminalLayoutsByTabId'>

type PaneTabTarget = { tab: VisibleTabRef; leafId: string | null }

type NavigationManager = Pick<PaneManager, 'getNumericIdForLeaf' | 'setActivePane'> & {
  getPanes(): Pick<ManagedPane, 'id' | 'leafId' | 'container'>[]
  getActivePane(): Pick<ManagedPane, 'id' | 'leafId' | 'container'> | null
}

export function resolveTerminalPaneTabTarget({
  state,
  worktreeId,
  tabId,
  activeLeafId,
  currentLeafIds,
  direction
}: {
  state: NavigationState
  worktreeId: string
  tabId: string
  activeLeafId: string
  currentLeafIds: readonly string[]
  direction: 'next' | 'previous'
}): PaneTabTarget | null {
  const currentIndex = currentLeafIds.indexOf(activeLeafId)
  if (currentIndex === -1) {
    return null
  }
  const step = direction === 'next' ? 1 : -1
  const tabModes = new Map(
    (state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab.viewMode])
  )
  const unifiedModes = new Map(
    (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab.viewMode])
  )
  const terminalLeaves = (tab: VisibleTabRef): string[] => {
    if (tab.id === tabId) {
      return [...currentLeafIds]
    }
    const layout = state.terminalLayoutsByTabId[tab.id]
    const leaves = collectLeafIdsInOrder(layout?.root)
    const mode = (tab.tabId ? unifiedModes.get(tab.tabId) : undefined) ?? tabModes.get(tab.id)
    if (mode !== 'chat') {
      return leaves
    }
    const chatLeaf = layout?.chatLeafId ?? resolveNativeChatActiveLayoutLeafId(layout)
    return chatLeaf ? leaves.filter((leafId) => leafId !== chatLeaf) : []
  }
  const tabs = getActiveTabNavOrder(state, worktreeId).filter((tab) => {
    if (tab.type !== 'terminal') {
      return false
    }
    const mode = (tab.tabId ? unifiedModes.get(tab.tabId) : undefined) ?? tabModes.get(tab.id)
    return mode !== 'chat' || terminalLeaves(tab).length > 0
  })
  const tabIndex = tabs.findIndex((tab) => tab.id === tabId)
  const currentTab = tabs[tabIndex] ?? { type: 'terminal', id: tabId }
  const nextIndex = currentIndex + step
  if (nextIndex >= 0 && nextIndex < currentLeafIds.length) {
    return { tab: currentTab, leafId: currentLeafIds[nextIndex] }
  }
  // A floating terminal or a not-yet-hydrated group must not jump into another surface.
  if (tabIndex === -1 || tabs.length <= 1) {
    return {
      tab: currentTab,
      leafId: direction === 'next' ? currentLeafIds[0] : currentLeafIds.at(-1)!
    }
  }
  const nextTab = tabs[(tabIndex + step + tabs.length) % tabs.length]
  const leaves = terminalLeaves(nextTab)
  return {
    tab: nextTab,
    leafId: direction === 'next' ? (leaves[0] ?? null) : (leaves.at(-1) ?? null)
  }
}

export function focusTerminalPaneAcrossTabs(
  manager: NavigationManager,
  worktreeId: string,
  tabId: string,
  direction: 'next' | 'previous'
): void {
  const panes = manager.getPanes().filter((pane) => !paneIsCoveredByNativeChat(pane))
  panes.sort((left, right) => {
    const position = left.container.compareDocumentPosition(right.container)
    if (position & Node.DOCUMENT_POSITION_DISCONNECTED) {
      return 0
    }
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
  const active = manager.getActivePane() ?? panes[0]
  if (!active) {
    return
  }
  const state = useAppStore.getState()
  const target = resolveTerminalPaneTabTarget({
    state,
    worktreeId,
    tabId,
    activeLeafId: active.leafId,
    currentLeafIds: panes.map((pane) => pane.leafId),
    direction
  })
  if (!target) {
    return
  }
  if (target.tab.id === tabId) {
    const paneId = target.leafId ? manager.getNumericIdForLeaf(target.leafId) : null
    if (paneId !== null) {
      manager.setActivePane(paneId, { focus: true })
    }
    return
  }
  activateTabAndFocusPane(target.tab.id, target.leafId, { collapseExpandedPane: true })
  if (target.tab.tabId) {
    state.activateTab(target.tab.tabId)
  }
  if (target.leafId === null) {
    focusTerminalTabSurface(target.tab.id)
  }
}
