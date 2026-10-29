import { ensureSimulatorTab } from '@/lib/ensure-simulator-tab'
import {
  isManualSimulatorLaunchPending,
  rememberPrelaunchedSimulatorSession
} from '@/lib/simulator-launch-coordination'
import {
  createFloatingWorkspaceBrowserTab,
  isFloatingWorkspacePanelFocused
} from '@/lib/floating-workspace-terminal-actions'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { toast } from 'sonner'
import { useAppStore } from '../../store'

export function registerContentCreationIpcBridge(
  unsubs: (() => void)[],
  isRuntimeEnvironmentActive: () => boolean
): void {
  const unsubscribeNewBrowserTab = window.api.ui.onNewBrowserTab?.(() => {
    const store = useAppStore.getState()
    if (isFloatingWorkspacePanelFocused()) {
      void createFloatingWorkspaceBrowserTab(store).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
      return
    }
    const worktreeId = store.activeWorktreeId
    if (!worktreeId) {
      return
    }
    const targetGroupId =
      store.activeGroupIdByWorktree[worktreeId] ?? store.groupsByWorktree[worktreeId]?.[0]?.id
    if (!targetGroupId) {
      return
    }
    void store.openNewBrowserTabInActiveWorkspace(targetGroupId).catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error))
    })
  })
  if (unsubscribeNewBrowserTab) {
    unsubs.push(unsubscribeNewBrowserTab)
  }

  const unsubscribeEmulatorAutoAttach = window.api.emulator?.onAutoAttach(
    ({ worktreeId, info }) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      if (isManualSimulatorLaunchPending(worktreeId)) {
        // Why: manual launches pre-attach so the ready pane opens in the right split, not as a hidden tab in this group.
        rememberPrelaunchedSimulatorSession(worktreeId, info)
        return
      }
      ensureSimulatorTab(worktreeId, {
        surfacePane: false,
        executionHostId: LOCAL_EXECUTION_HOST_ID
      })
      // A watcher can find an already-mounted simulator; publish stream info without reattaching it.
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('orca:emulator-auto-attach', {
            detail: { worktreeId, info }
          })
        )
      }, 0)
    }
  )
  if (unsubscribeEmulatorAutoAttach) {
    unsubs.push(unsubscribeEmulatorAutoAttach)
  }

  const unsubscribeEmulatorPaneFocus = window.api.emulator?.onPaneFocus(({ worktreeId }) => {
    if (isRuntimeEnvironmentActive()) {
      return
    }
    ensureSimulatorTab(worktreeId, {
      surfacePane: true,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  })
  if (unsubscribeEmulatorPaneFocus) {
    unsubs.push(unsubscribeEmulatorPaneFocus)
  }

  // Why: reply with the page ID so main can await registerGuest before returning to the CLI.
}
