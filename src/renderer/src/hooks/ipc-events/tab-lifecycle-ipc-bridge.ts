import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import { warnAmbiguousOwnerOnce } from '@/lib/ambiguous-owner-warning'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
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
      const owner = runtimeEnvironmentIdForWorkspaceOwner(store, { workspaceId: worktreeId })
      if (owner.kind === 'ambiguous') {
        // Why: a local tab here would start a shell on this computer for a workspace two hosts publish.
        warnAmbiguousOwnerOnce(worktreeId, 'open a new terminal tab')
        return
      }
      const environmentId = owner.environmentId
      void (async () => {
        const outcome = await createWebRuntimeSessionTerminal({
          worktreeId,
          environmentId,
          activate: true
        })
        if (outcome.status === 'created' || isWebRuntimeSessionActive(environmentId)) {
          return
        }
        const tabId = createBrowserUuid()
        store.createTab(worktreeId, undefined, undefined, { id: tabId })
        store.setActiveTabType('terminal', worktreeId)
        persistAgentLaunchTabOrder(worktreeId, tabId)
        focusTerminalTabSurface(tabId)
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
