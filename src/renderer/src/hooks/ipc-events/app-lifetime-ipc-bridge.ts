import { observeJiraImageHostStatus } from '@/runtime/runtime-jira-image-cache'
import { observeRuntimeHostStatusForPendingRemovals } from '@/store/repos/pending-runtime-repo-removal-replay'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import { getTabIdsAwaitingHostHydrationRemount } from '@/lib/parked-terminal-host-hydration'
import { emitAutomationsChangedWindowEvent } from '@/lib/automations-changed-window-event'
import { createBackgroundSleepingAgentWakeDispatcher } from '@/lib/wake-sleeping-agents-in-background'
import { remoteRuntimeTerminalColorPush } from '@/runtime/remote-runtime-terminal-color-push'
import { resetAgentHookCompletionNotificationCoordinators } from '../agent-hook-completion-notifications'
import { useAppStore } from '../../store'
import { registerAgentStatusIpcBridge } from './agent-status-ipc-bridge'
import { registerBackgroundWorktreeRemovalBridge } from './background-worktree-removal-bridge'
import {
  registerBrowserRequestIpcBridge,
  signalBrowserTabRequestsReadyAfterRestore
} from './browser-request-ipc-bridge'
import { registerBrowserTabActivateIpcBridge } from './browser-tab-activate-ipc-bridge'
import { registerBrowserStateIpcBridge } from './browser-state-ipc-bridge'
import { registerContentCreationIpcBridge } from './content-creation-ipc-bridge'
import { registerDirectSshStateIpcBridge } from './direct-ssh-state-ipc-bridge'
import { registerMobileAndTerminalCloseIpcBridge } from './mobile-terminal-close-ipc-bridge'
import { registerMobileDriverIpcBridge } from './mobile-driver-ipc-bridge'
import { registerOrcaProfileAuthIpcBridge } from './orca-profile-auth-ipc-bridge'
import { registerOsMarkdownFileOpenBridge } from './os-markdown-file-open-bridge'
import { registerProjectCatalogIpcBridge } from './project-catalog-ipc-bridge'
import { registerRateLimitIpcBridge } from './rate-limit-ipc-bridge'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'
import { registerSessionTabIpcBridge } from './session-tab-ipc-bridge'
import { registerSettingsAndSidebarIpcBridge } from './settings-sidebar-ipc-bridge'
import { registerQuitAndStopAllSessionsIpcBridge } from './quit-and-stop-all-sessions-ipc-bridge'
import { registerTabLifecycleIpcBridge } from './tab-lifecycle-ipc-bridge'
import { registerTerminalPresentationIpcBridge } from './terminal-presentation-ipc-bridge'
import { registerPtySourceDisownedIpcBridge } from './pty-source-disowned-ipc-bridge'
import { registerTerminalRequestIpcBridge } from './terminal-request-ipc-bridge'
import { registerAgentLaunchTabIpcBridge } from './agent-launch-tab-ipc-bridge'
import { registerTerminalPaneRevealIpcBridge } from './terminal-pane-reveal-ipc-bridge'
import { registerTerminalUiRoutingIpcBridge } from './terminal-ui-routing-ipc-bridge'
import { registerUpdaterStatusIpcBridge } from './updater-status-ipc-bridge'
import { createWorktreeEventRuntime } from './worktree-event-runtime'
import { registerWorkspaceShortcutIpcBridge } from './workspace-shortcut-ipc-bridge'
import { registerZoomIpcBridge } from './zoom-ipc-bridge'
import { registerWslAccountNoticeIpcBridge } from './wsl-account-notice-ipc-bridge'
import { registerWslHostIpcBridge } from './wsl-host-ipc-bridge'

function isRuntimeEnvironmentActive(): boolean {
  return Boolean(useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim())
}

function remountTerminalTabsAwaitingHostHydration(): void {
  const store = useAppStore.getState()
  for (const tabId of getTabIdsAwaitingHostHydrationRemount(store)) {
    store.remountTerminalTabForRecovery(tabId)
  }
}

export function installAppLifetimeIpcEvents(): () => void {
  const unsubs: (() => void)[] = []
  const backgroundWakeDispatcher = createBackgroundSleepingAgentWakeDispatcher()
  unsubs.push(backgroundWakeDispatcher.dispose)
  unsubs.push(
    window.api.automations.onChanged((payload) => emitAutomationsChangedWindowEvent(payload))
  )

  const worktreeRuntime = createWorktreeEventRuntime(unsubs, isRuntimeEnvironmentActive)
  const statusApi = window.api.runtimeEnvironments
  if (statusApi?.onStatusChanged) {
    const apply = (snapshot: RuntimeHostStatusSnapshot): void => {
      useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot)
      observeRuntimeHostStatusForPendingRemovals(snapshot)
      remoteRuntimeTerminalColorPush.observeStatusSnapshot(snapshot)
      observeJiraImageHostStatus(snapshot)
    }
    let stopped = false
    unsubs.push(statusApi.onStatusChanged(apply), () => {
      stopped = true
    })
    void statusApi
      .getStatusSnapshots()
      .then((snapshots) => {
        if (!stopped) {
          snapshots.forEach(apply)
        }
      })
      .catch((error) => console.error('Failed to read runtime status snapshots:', error))
  }
  const unsubscribeRuntimeEnvironmentStore = registerRuntimeClientIpcBridge(unsubs, worktreeRuntime)
  registerBackgroundWorktreeRemovalBridge(unsubs)
  registerWslHostIpcBridge(unsubs)
  registerProjectCatalogIpcBridge(
    unsubs,
    worktreeRuntime.worktreeChangeRefreshQueue,
    isRuntimeEnvironmentActive,
    remountTerminalTabsAwaitingHostHydration
  )
  registerSettingsAndSidebarIpcBridge(unsubs)
  registerQuitAndStopAllSessionsIpcBridge(unsubs)
  registerOrcaProfileAuthIpcBridge(unsubs)
  registerWorkspaceShortcutIpcBridge(unsubs)
  registerOsMarkdownFileOpenBridge(unsubs)
  registerWslAccountNoticeIpcBridge(unsubs)
  unsubs.push(
    window.api.ui.onActivateWorktree(
      ({ repoId, worktreeId, setup, startup, defaultTabs, providesInitialSurface }) => {
        void worktreeRuntime
          .activateNotifiedWorktree(
            {
              type: 'activateWorktree',
              repoId,
              worktreeId,
              ...(setup ? { setup } : {}),
              ...(startup ? { startup } : {}),
              ...(defaultTabs ? { defaultTabs } : {}),
              ...(providesInitialSurface ? { providesInitialSurface } : {})
            },
            { allowRuntimeEnvironment: false }
          )
          .catch((error) => console.error('Failed to activate CLI-created worktree:', error))
      }
    )
  )

  registerTerminalPresentationIpcBridge(unsubs)
  registerTerminalRequestIpcBridge(unsubs)
  registerAgentLaunchTabIpcBridge(unsubs)
  registerPtySourceDisownedIpcBridge(unsubs)
  registerTerminalUiRoutingIpcBridge(unsubs)
  registerTerminalPaneRevealIpcBridge(unsubs)
  registerSessionTabIpcBridge(unsubs)
  registerMobileAndTerminalCloseIpcBridge(unsubs, backgroundWakeDispatcher.request)
  registerUpdaterStatusIpcBridge(unsubs)
  registerBrowserStateIpcBridge(unsubs, isRuntimeEnvironmentActive)
  registerContentCreationIpcBridge(unsubs, isRuntimeEnvironmentActive)
  registerBrowserRequestIpcBridge(unsubs)
  signalBrowserTabRequestsReadyAfterRestore(unsubs)
  registerBrowserTabActivateIpcBridge(unsubs)
  registerTabLifecycleIpcBridge(unsubs)
  registerRateLimitIpcBridge(unsubs)
  const stopDirectSshStateBridge = registerDirectSshStateIpcBridge(unsubs)
  registerZoomIpcBridge(unsubs)
  const agentStatusBridge = registerAgentStatusIpcBridge(unsubs)
  const disposeMobileDriverHydration = registerMobileDriverIpcBridge(
    unsubs,
    isRuntimeEnvironmentActive
  )

  return () => {
    agentStatusBridge.disposeAsyncState()
    disposeMobileDriverHydration()
    unsubscribeRuntimeEnvironmentStore()
    agentStatusBridge.unsubscribeStore()
    unsubs.forEach((unsubscribe) => unsubscribe())
    stopDirectSshStateBridge()
    resetAgentHookCompletionNotificationCoordinators()
  }
}
