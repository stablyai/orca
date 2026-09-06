import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { closeBrowserWorkspaceTabOnHosts } from '@/runtime/browser-workspace-tab-close'
import { destroyWorkspaceWebviews } from '@/store/slices/browser-webview-cleanup'
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
import { resolveBrowserWorkspaceOwner } from '../../lib/browser-workspace-source-resolution'
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
    window.api.ui.onCloseActiveTab((payload) => {
      // Why: the empty-panel toggle is the ambient fallback only. A guest-originated close names a
      // main-workspace target, so an open-but-empty floating panel must not swallow it.
      if (!payload?.sourceId && isEmptyFloatingWorkspacePanelVisible()) {
        window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
        return
      }
      const store = useAppStore.getState()
      // Why: a guest-originated close names its own page; the activeTabType mirror goes stale in
      // split layouts (guest focus never reaches the group's focus-capture), so trust the source id.
      const explicitTarget = payload?.sourceId
        ? resolveBrowserWorkspaceOwner(store, payload.sourceId)
        : null
      if (payload?.sourceId && !explicitTarget) {
        // Stale id (guest closed between keydown and IPC) = no-op, never the ambient fallback.
        return
      }
      if (explicitTarget || (store.activeTabType === 'browser' && store.activeBrowserTabId)) {
        const tabId = explicitTarget?.workspaceId ?? store.activeBrowserTabId
        const worktreeId = explicitTarget?.worktreeId ?? store.activeWorktreeId
        if (!tabId) {
          return
        }
        const closeActiveBrowserTab = (): void => {
          const currentStore = useAppStore.getState()
          if (!worktreeId) {
            currentStore.closeBrowserTab(tabId)
            return
          }
          // Why: the menu's Close Tab used to decide ownership itself — "runtime connected means
          // the host owns it" — which fires an inert close at a local-only or still-staged tab.
          // The shared plan is the one authority on who tears a browser workspace down.
          const plan = closeBrowserWorkspaceTabOnHosts({
            state: currentStore,
            worktreeId,
            workspaceId: tabId,
            visibleTabId: tabId,
            focusedEnvironmentId: getRuntimeEnvironmentIdForWorktree(currentStore, worktreeId)
          })
          if (plan.closesLocally) {
            // Why before the teardown: closeBrowserTab announces the MRU page selection, and a
            // guest torn down first leaves the fallback picking registration order (#16306).
            currentStore.closeBrowserTab(
              tabId,
              plan.localCloseReason ? { reason: plan.localCloseReason } : undefined
            )
            destroyWorkspaceWebviews(currentStore.browserPagesByWorkspace, tabId)
            return
          }
          if (plan.removesVisibleTab) {
            const mirroredTab = (currentStore.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (candidate) => candidate.contentType === 'browser' && candidate.entityId === tabId
            )
            if (mirroredTab) {
              currentStore.closeUnifiedTab(mirroredTab.id)
            }
          }
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
