import { useAppStore } from '@/store'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'

export function createNewTerminalTab(
  activeWorktreeId: string | null,
  shellOverride?: string
): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  const runtimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why: paired web clients receive host-owned terminal tabs through
    // session.tabs. Creating a local tab first races the host snapshot and can
    // leave stale remote handles in the web store.
    void createWebRuntimeSessionTerminal({
      worktreeId: activeWorktreeId,
      command: shellOverride,
      activate: true
    })
    return
  }
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

export function closeOtherTerminalTabs(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  const currentTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  state.setActiveTab(tabId)
  const runtimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  for (const tab of currentTabs) {
    if (tab.id !== tabId) {
      if (closeHostTerminalTabs) {
        // Why: paired web tabs are host-owned; local-only bulk close leaves
        // the host to re-publish the supposedly closed terminal tabs.
        void closeWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId: tab.id,
          environmentId: runtimeEnvironmentId
        })
      } else {
        state.closeTab(tab.id)
      }
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
  const runtimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
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
      if (closeHostTerminalTabs) {
        // Why: paired web tabs are host-owned; local-only bulk close leaves
        // the host to re-publish the supposedly closed terminal tabs.
        void closeWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId: id,
          environmentId: runtimeEnvironmentId
        })
      } else {
        state.closeTab(id)
      }
    } else {
      useAppStore.getState().closeFile(id)
    }
  }
}

export function activateTerminalTab(tabId: string): void {
  const s = useAppStore.getState()
  const owningWorktreeId =
    Object.entries(s.tabsByWorktree).find(([, worktreeTabs]) =>
      worktreeTabs.some((tab) => tab.id === tabId)
    )?.[0] ?? null
  const runtimeEnvironmentId = s.settings?.activeRuntimeEnvironmentId?.trim()
  if (owningWorktreeId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why: activation needs to update the host's active tab as well as the
    // local optimistic state, otherwise the next host snapshot snaps back.
    void activateWebRuntimeSessionTab({
      worktreeId: owningWorktreeId,
      tabId,
      environmentId: runtimeEnvironmentId
    })
  }
  s.setActiveTab(tabId)
  s.setActiveTabType('terminal')
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
