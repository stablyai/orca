import { useAppStore } from '@/store'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'

export function createNewTerminalTab(
  activeWorktreeId: string | null,
  shellOverride?: string
): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  const newTab = state.createTab(activeWorktreeId, undefined, shellOverride)
  state.setActiveTabType('terminal')
  // Why: persist the tab bar order with the new terminal at the end of the
  // current visual order. Without this, reconcileTabOrder falls back to
  // terminals-first when tabBarOrderByWorktree is unset, causing a new
  // terminal to jump to index 0 instead of appending after editor tabs.
  const freshState = useAppStore.getState()
  const termIds = (freshState.tabsByWorktree[activeWorktreeId] ?? []).map((t) => t.id)
  const editorIds = freshState.openFiles
    .filter((f) => f.worktreeId === activeWorktreeId)
    .map((f) => f.id)
  const base = reconcileTabOrder(
    freshState.tabBarOrderByWorktree[activeWorktreeId],
    termIds,
    editorIds
  )
  // The new tab is already in base via termIds; move it to the end
  const order = base.filter((id) => id !== newTab.id)
  order.push(newTab.id)
  state.setTabBarOrder(activeWorktreeId, order)
}

export function closeTerminalTab(tabId: string): void {
  const state = useAppStore.getState()
  const owningWorktreeEntry = Object.entries(state.tabsByWorktree).find(([, worktreeTabs]) =>
    worktreeTabs.some((tab) => tab.id === tabId)
  )
  const owningWorktreeId = owningWorktreeEntry?.[0] ?? null

  if (!owningWorktreeId) {
    return
  }

  const currentTabs = state.tabsByWorktree[owningWorktreeId] ?? []
  if (currentTabs.length <= 1) {
    state.closeTab(tabId)
    if (state.activeWorktreeId === owningWorktreeId) {
      // Why: only deactivate the worktree when no tabs of any kind remain.
      // Editor files are a separate tab type; closing the last terminal tab
      // should switch to the editor view instead of tearing down the workspace.
      const worktreeFile = state.openFiles.find((f) => f.worktreeId === owningWorktreeId)
      if (worktreeFile) {
        state.setActiveFile(worktreeFile.id)
        state.setActiveTabType('editor')
      } else {
        state.setActiveWorktree(null)
      }
    }
    return
  }

  if (state.activeWorktreeId === owningWorktreeId && tabId === state.activeTabId) {
    const currentIndex = currentTabs.findIndex((tab) => tab.id === tabId)
    const nextTab = currentTabs[currentIndex + 1] ?? currentTabs[currentIndex - 1]
    if (nextTab) {
      state.setActiveTab(nextTab.id)
    }
  }

  state.closeTab(tabId)
}

export function closeOtherTerminalTabs(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  const currentTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  state.setActiveTab(tabId)
  for (const tab of currentTabs) {
    if (tab.id !== tabId) {
      state.closeTab(tab.id)
    }
  }
}

export function closeTerminalTabsToRight(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }

  const state = useAppStore.getState()
  const currentTerminalTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  const currentEditorFiles = state.openFiles.filter((f) => f.worktreeId === activeWorktreeId)
  const terminalIds = currentTerminalTabs.map((t) => t.id)
  const terminalIdSet = new Set(terminalIds)
  const orderedIds = reconcileTabOrder(
    state.tabBarOrderByWorktree[activeWorktreeId],
    terminalIds,
    currentEditorFiles.map((f) => f.id)
  )

  const index = orderedIds.indexOf(tabId)
  if (index === -1) {
    return
  }
  const rightIds = orderedIds.slice(index + 1)
  for (const id of rightIds) {
    if (terminalIdSet.has(id)) {
      state.closeTab(id)
    } else {
      useAppStore.getState().closeFile(id)
    }
  }
}

export function activateTerminalTab(tabId: string): void {
  const s = useAppStore.getState()
  s.setActiveTab(tabId)
  s.setActiveTabType('terminal')
}

export function activateEditorFile(fileId: string): void {
  const s = useAppStore.getState()
  s.setActiveFile(fileId)
  s.setActiveTabType('editor')
}

export function toggleTerminalPaneExpand(tabId: string): void {
  useAppStore.getState().setActiveTab(tabId)
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId }
      })
    )
  })
}
