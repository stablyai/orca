import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  closeWebRuntimeSessionTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel
} from '../../store/pinned-tab-close-guard'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import {
  createFloatingWorkspaceTerminalTab,
  isEmptyFloatingWorkspacePanelVisible,
  isFloatingWorkspacePanelFocused,
  resolveFloatingWorkspaceBrowserWorkspaceId,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import {
  dispatchFloatingWorkspaceGuestClose,
  dispatchFloatingWorkspaceGuestSelectIndex
} from '@/lib/floating-workspace-guest-bridge'

import { useAppStore } from '../../store'
import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from '../ipc-tab-switch'
function getWorktreeRuntimeEnvironmentId(worktreeId: string | null | undefined): string | null {
  return getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)
}

export function registerTabLifecycleIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onNewTerminalTab(() => {
      const store = useAppStore.getState()
      if (isFloatingWorkspacePanelFocused()) {
        void createFloatingWorkspaceTerminalTab(store)
        return
      }
      const worktreeId = store.activeWorktreeId
      if (!worktreeId) {
        return
      }
      void (async () => {
        const environmentId = getWorktreeRuntimeEnvironmentId(worktreeId)
        const outcome = await createWebRuntimeSessionTerminal({
          worktreeId,
          environmentId,
          activate: true
        })
        if (outcome.status === 'created' || isWebRuntimeSessionActive(environmentId)) {
          return
        }
        const newTab = store.createTab(worktreeId)
        store.setActiveTabType('terminal')
        // Why: mirror Terminal.tsx handleNewTab so a new tab appends at the end, not index 0, when tabBarOrder is unset.
        const freshStore = useAppStore.getState()
        const currentTerminals = freshStore.tabsByWorktree[worktreeId] ?? []
        const currentEditors = freshStore.openFiles.filter((f) => f.worktreeId === worktreeId)
        const currentBrowsers = freshStore.browserTabsByWorktree[worktreeId] ?? []
        const stored = freshStore.tabBarOrderByWorktree[worktreeId]
        const termIds = currentTerminals.map((t) => t.id)
        const editorIds = currentEditors.map((f) => f.id)
        const browserIds = currentBrowsers.map((tab) => tab.id)
        const validIds = new Set([...termIds, ...editorIds, ...browserIds])
        const base = (stored ?? []).filter((id) => validIds.has(id))
        const inBase = new Set(base)
        for (const id of [...termIds, ...editorIds, ...browserIds]) {
          if (!inBase.has(id)) {
            base.push(id)
            inBase.add(id)
          }
        }
        const order = base.filter((id) => id !== newTab.id)
        order.push(newTab.id)
        freshStore.setTabBarOrder(worktreeId, order)
        focusTerminalTabSurface(newTab.id)
      })()
    })
  )

  unsubs.push(
    window.api.ui.onCloseActiveTab(() => {
      if (isEmptyFloatingWorkspacePanelVisible()) {
        window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
        return
      }
      const store = useAppStore.getState()
      if (store.activeTabType === 'browser' && store.activeBrowserTabId) {
        const tabId = store.activeBrowserTabId
        const worktreeId = store.activeWorktreeId
        const closeActiveBrowserTab = (): void => {
          const currentStore = useAppStore.getState()
          const environmentId = getWorktreeRuntimeEnvironmentId(worktreeId)
          if (environmentId && worktreeId) {
            if (!isWebRuntimeSessionActive(environmentId)) {
              currentStore.closeBrowserTab(tabId)
              return
            }
            void closeWebRuntimeSessionTab({
              worktreeId,
              tabId,
              environmentId,
              reason: 'user'
            })
            return
          }
          currentStore.closeBrowserTab(tabId)
        }
        if (worktreeId && isUnifiedTabPinned(store, worktreeId, tabId)) {
          guardPinnedTabClose({
            isPinned: true,
            tabLabel: resolvePinnedTabLabel(store, worktreeId, tabId),
            onClose: closeActiveBrowserTab
          })
          return
        }
        closeActiveBrowserTab()
      }
    })
  )

  unsubs.push(
    window.api.ui.onCloseFloatingItem(({ sourceId }) => {
      // Main forwards the guest's browser *page* id; resolve it to the owning live floating
      // browser workspace (the id space the panel closes by), then hand off to the mounted
      // panel's own close closure (pin guard + reclaim intent). Stale id = no-op.
      const workspaceId = resolveFloatingWorkspaceBrowserWorkspaceId(
        useAppStore.getState(),
        sourceId
      )
      if (!workspaceId) {
        return
      }
      dispatchFloatingWorkspaceGuestClose({ sourceId: workspaceId })
    })
  )
  unsubs.push(
    window.api.ui.onSelectFloatingIndex(({ index }) => {
      dispatchFloatingWorkspaceGuestSelectIndex({ index })
    })
  )

  unsubs.push(
    window.api.ui.onSwitchTab((direction) => {
      const store = useAppStore.getState()
      if (isFloatingWorkspacePanelFocused()) {
        switchFloatingWorkspaceTab(store, direction, 'same-type')
        return
      }
      handleSwitchTab(direction)
    })
  )
  unsubs.push(
    window.api.ui.onSwitchTabAcrossAllTypes((direction) => {
      const store = useAppStore.getState()
      if (isFloatingWorkspacePanelFocused()) {
        switchFloatingWorkspaceTab(store, direction, 'all-types')
        return
      }
      handleSwitchTabAcrossAllTypes(direction)
    })
  )
  unsubs.push(window.api.ui.onSwitchRecentTab(handleSwitchRecentTab))
  unsubs.push(
    window.api.ui.onSwitchTerminalTab((direction) => {
      const store = useAppStore.getState()
      if (isFloatingWorkspacePanelFocused()) {
        switchFloatingWorkspaceTab(store, direction, 'terminal')
        return
      }
      handleSwitchTerminalTab(direction)
    })
  )
}
