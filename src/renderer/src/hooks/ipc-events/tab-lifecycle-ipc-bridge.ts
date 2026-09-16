import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import {
  createFloatingWorkspaceTerminalTab,
  isFloatingWorkspacePanelFocused,
  resolveFloatingWorkspaceBrowserWorkspaceId
} from '@/lib/floating-workspace-terminal-actions'
import {
  dispatchFloatingWorkspaceGuestClose,
  dispatchFloatingWorkspaceGuestSelectIndex
} from '@/lib/floating-workspace-guest-bridge'

import { useAppStore } from '../../store'
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
      dispatchWorkspaceTabCommand({
        type: 'close',
        ...(payload?.sourceId
          ? { target: { kind: 'browser-source', sourceId: payload.sourceId } as const }
          : {})
      })
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
      dispatchWorkspaceTabCommand({ type: 'switch', direction, scope: 'same-type' })
    }),
    window.api.ui.onSwitchTabAcrossAllTypes((direction) => {
      dispatchWorkspaceTabCommand({ type: 'switch', direction, scope: 'all-types' })
    }),
    window.api.ui.onSwitchRecentTab(() => {
      dispatchWorkspaceTabCommand({ type: 'previous-recent' })
    }),
    window.api.ui.onSwitchTerminalTab((direction) => {
      dispatchWorkspaceTabCommand({ type: 'switch', direction, scope: 'terminal' })
    })
  )
}
