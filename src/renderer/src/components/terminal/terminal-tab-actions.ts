import { useAppStore } from '@/store'
import type { TabContentType } from '../../../../shared/types'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import { resolveHostSessionTabIdForWebSessionTab } from '@/runtime/web-session-tabs-sync'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

const EDITOR_TAB_CONTENT_TYPES = new Set<TabContentType>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

type TerminalTabActionState = ReturnType<typeof useAppStore.getState>

type CloseTerminalTabTarget = {
  worktreeId: string
  terminalTabId: string
}

function resolveCloseTerminalTabTarget(
  state: TerminalTabActionState,
  tabId: string
): CloseTerminalTabTarget | null {
  for (const [worktreeId, worktreeTabs] of Object.entries(state.tabsByWorktree)) {
    if (worktreeTabs.some((tab) => tab.id === tabId)) {
      return { worktreeId, terminalTabId: tabId }
    }
  }

  for (const [worktreeId, unifiedTabs] of Object.entries(state.unifiedTabsByWorktree ?? {})) {
    const unified = unifiedTabs.find(
      (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
    )
    if (unified) {
      return { worktreeId, terminalTabId: unified.entityId }
    }
  }

  return null
}

// Why: host-backed terminals may only exist in unifiedTabsByWorktree as
// terminal entities, so close/sibling selection must merge tabsByWorktree and
// unified terminal entityIds into one deduped list per worktree.
function getWorktreeTerminalTabIds(state: TerminalTabActionState, worktreeId: string): string[] {
  const ids = new Set<string>()
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    ids.add(tab.id)
  }
  for (const tab of state.unifiedTabsByWorktree?.[worktreeId] ?? []) {
    if (tab.contentType === 'terminal') {
      ids.add(tab.entityId)
    }
  }
  return [...ids]
}

function closeLocalTerminalTabState(terminalTabId: string): void {
  const state = useAppStore.getState()
  if (
    Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === terminalTabId))
  ) {
    state.closeTab(terminalTabId)
    return
  }

  for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
    const unified = tabs.find(
      (tab) =>
        tab.contentType === 'terminal' &&
        (tab.entityId === terminalTabId || tab.id === terminalTabId)
    )
    if (unified) {
      state.closeUnifiedTab(unified.id)
      return
    }
  }
}

function isPinnedVisibleTab(
  state: TerminalTabActionState,
  worktreeId: string,
  visibleId: string
): boolean {
  return (
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => (tab.id === visibleId || tab.entityId === visibleId) && tab.isPinned
    ) ?? false
  )
}

export function createNewTerminalTab(
  activeWorktreeId: string | null,
  shellOverride?: string
): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why: paired web clients receive host-owned terminal tabs through
    // session.tabs. Creating a local tab first races the host snapshot and can
    // leave stale remote handles in the web store.
    void createWebRuntimeSessionTerminal({
      worktreeId: activeWorktreeId,
      environmentId: runtimeEnvironmentId,
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

export function closeTerminalTab(tabId: string): void {
  const state = useAppStore.getState()
  const target = resolveCloseTerminalTabTarget(state, tabId)
  if (!target) {
    return
  }
  const { worktreeId: owningWorktreeId, terminalTabId } = target

  if (isPinnedVisibleTab(state, owningWorktreeId, terminalTabId)) {
    return
  }

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, owningWorktreeId)
  if (runtimeEnvironmentId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    const hostBackedTabId =
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId: runtimeEnvironmentId,
        worktreeId: owningWorktreeId,
        tabId: terminalTabId
      }) ?? (isWebTerminalSurfaceTabId(terminalTabId) ? terminalTabId : null)
    if (hostBackedTabId) {
      // Why: prune local mirrors immediately so close feels responsive while the
      // host session snapshot catches up.
      closeLocalTerminalTabState(terminalTabId)
      void closeWebRuntimeSessionTab({
        worktreeId: owningWorktreeId,
        tabId: hostBackedTabId,
        environmentId: runtimeEnvironmentId
      })
      return
    }
    // Why: legacy local-only tabs (e.g. agent quick launch before host routing)
    // have no host session binding and must still close locally.
  }

  const currentTerminalTabIds = getWorktreeTerminalTabIds(state, owningWorktreeId)
  if (currentTerminalTabIds.length <= 1) {
    closeLocalTerminalTabState(terminalTabId)
    if (state.activeWorktreeId === owningWorktreeId) {
      // Why: only deactivate the worktree when no tabs of any kind remain.
      // Editor files are a separate tab type; closing the last terminal tab
      // should switch to the editor view instead of tearing down the workspace.
      const worktreeFile = state.openFiles.find((f) => f.worktreeId === owningWorktreeId)
      if (worktreeFile) {
        state.setActiveFile(worktreeFile.id)
        state.setActiveTabType('editor')
      } else {
        const browserTab = (state.browserTabsByWorktree?.[owningWorktreeId] ?? [])[0]
        if (browserTab) {
          state.setActiveBrowserTab(browserTab.id)
          state.setActiveTabType('browser')
        } else {
          state.setActiveWorktree(null)
        }
      }
    }
    return
  }

  if (state.activeWorktreeId === owningWorktreeId && terminalTabId === state.activeTabId) {
    const currentIndex = currentTerminalTabIds.indexOf(terminalTabId)
    const nextTabId =
      currentTerminalTabIds[currentIndex + 1] ?? currentTerminalTabIds[currentIndex - 1]
    if (nextTabId) {
      state.setActiveTab(nextTabId)
    }
  }

  closeLocalTerminalTabState(terminalTabId)
}

export function closeOtherTerminalTabs(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  const currentTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  state.setActiveTab(tabId)
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  for (const tab of currentTabs) {
    if (tab.id !== tabId) {
      if (isPinnedVisibleTab(state, activeWorktreeId, tab.id)) {
        continue
      }
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
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
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
    if (isPinnedVisibleTab(state, activeWorktreeId, id)) {
      continue
    }
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
      const unifiedTab = (state.unifiedTabsByWorktree?.[activeWorktreeId] ?? []).find(
        (tab) => tab.entityId === id && EDITOR_TAB_CONTENT_TYPES.has(tab.contentType)
      )
      if (!unifiedTab?.isPinned) {
        useAppStore.getState().closeFile(id)
      }
    }
  }
}

export function activateTerminalTab(tabId: string): void {
  const s = useAppStore.getState()
  const owningWorktreeId =
    Object.entries(s.tabsByWorktree).find(([, worktreeTabs]) =>
      worktreeTabs.some((tab) => tab.id === tabId)
    )?.[0] ?? null
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(s, owningWorktreeId)
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
