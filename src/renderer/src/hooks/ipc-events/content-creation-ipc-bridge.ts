import { ensureSimulatorTab } from '@/lib/ensure-simulator-tab'
import { openMobileEmulatorTab } from '@/lib/open-mobile-emulator-tab'
import {
  isManualSimulatorLaunchPending,
  rememberPrelaunchedSimulatorSession
} from '@/lib/simulator-launch-coordination'
import {
  createFloatingWorkspaceBrowserTab,
  createFloatingWorkspaceMarkdownTab,
  isFloatingWorkspacePanelFocused
} from '@/lib/floating-workspace-terminal-actions'
import { translate } from '@/i18n/i18n'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { toast } from 'sonner'
import { useAppStore } from '../../store'

export function registerContentCreationIpcBridge(
  unsubs: (() => void)[],
  isRuntimeEnvironmentActive: () => boolean
): void {
  unsubs.push(
    window.api.ui.onNewBrowserTab(() => {
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
  )

  unsubs.push(
    window.api.ui.onNewMarkdownTab(() => {
      const store = useAppStore.getState()
      if (isFloatingWorkspacePanelFocused()) {
        void createFloatingWorkspaceMarkdownTab(store).catch((err) => {
          toast.error(
            err instanceof Error
              ? err.message
              : translate(
                  'auto.hooks.useIpcEvents.56d3ec4203',
                  'Failed to create untitled markdown file.'
                )
          )
        })
        return
      }
      const worktreeId = store.activeWorktreeId
      if (!worktreeId) {
        return
      }
      const targetGroupId =
        store.activeGroupIdByWorktree[worktreeId] ?? store.groupsByWorktree[worktreeId]?.[0]?.id
      if (targetGroupId) {
        void store.openNewMarkdownInActiveWorkspace(targetGroupId)
      }
    })
  )

  // Why: emulator IPC is additive; guard so older clients or partial preload mocks don't crash the hook when it's absent.
  const unsubscribeNewSimulatorTab = window.api.ui.onNewSimulatorTab?.(() => {
    if (isRuntimeEnvironmentActive()) {
      return
    }
    const store = useAppStore.getState()
    const worktreeId = store.activeWorktreeId
    if (!worktreeId) {
      return
    }
    void openMobileEmulatorTab(worktreeId, { placement: 'rightSplit' }).catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error))
    })
  })
  if (unsubscribeNewSimulatorTab) {
    unsubs.push(unsubscribeNewSimulatorTab)
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
      // Why: watcher may detect a helper while a simulator tab is already mounted; push stream info so the pane updates without re-attach.
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
