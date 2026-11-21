import { installBrowserInitializationPresentationLifetime } from '@/runtime/web-session-tabs-sync/tab-projection/browser-initialization-presentation'
import { setSleepingMailWorktrees } from '@/attention/sleeping-mail-worktrees'
import { observeJiraImageHostStatus } from '@/runtime/jira/runtime-jira-image-cache'
import { observeRuntimeHostStatusForPendingRemovals } from '@/store/repos/pending-runtime-repo-removal-replay'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { installBotHostListing } from '@/lib/bot-host-listing'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { getTabIdsAwaitingHostHydrationRemount } from '@/components/terminal-pane/mounting/parked-terminal-host-hydration'
import { emitAutomationsChangedWindowEvent } from '@/components/automations/events/automations-changed-window-event'
import { emitWorkspaceCleanupRunFinishedWindowEvent } from '@/components/workspace-cleanup/events/workspace-cleanup-run-finished-window-event'
import { createBackgroundSleepingAgentWakeDispatcher } from '@/lib/agent-session/resume/wake-sleeping-agents-in-background'
import { remoteRuntimeTerminalColorPush } from '@/runtime/hosted-terminals/streams/remote-runtime-terminal-color-push'
import { resetAgentHookCompletionNotificationCoordinators } from '../../components/terminal-pane/agent-completion/hook-lane/agent-hook-completion-notifications'
import { useAppStore } from '../../store/index'
import { registerAgentStatusIpcBridge } from './agent-status/agent-status-ipc-bridge'
import { registerBackgroundWorktreeRemovalBridge } from './workspace-catalog/background-worktree-removal-bridge'
import {
  registerBrowserRequestIpcBridge,
  signalBrowserTabRequestsReadyAfterRestore
} from './browser/browser-request-ipc-bridge'
import { registerBrowserTabActivateIpcBridge } from './browser/browser-tab-activate-ipc-bridge'
import { registerBrowserStateIpcBridge } from './browser/browser-state-ipc-bridge'
import { registerContentCreationIpcBridge } from '../../lib/simulator/launch/content-creation-ipc-bridge'
import { registerDirectSshStateIpcBridge } from './direct-ssh/direct-ssh-state-ipc-bridge'
import { registerEphemeralVmLifecycleIpcBridge } from '../../runtime/ephemeral-vm/ephemeral-vm-lifecycle-ipc-bridge'
import { registerMobileAndTerminalCloseIpcBridge } from './mobile-driver/mobile-terminal-close-ipc-bridge'
import { registerMobileDriverIpcBridge } from './mobile-driver/mobile-driver-ipc-bridge'
import { registerOrcaProfileAuthIpcBridge } from '../../components/orca-profiles/orca-profile-auth-ipc-bridge'
import { registerPluginViewIpcBridge } from '../../components/plugins/view/plugin-view-ipc-bridge'
import { registerPreflightWslRetryIpcBridge } from '../../runtime/hosts/wsl/preflight-wsl-retry-ipc-bridge'
import { registerOsMarkdownFileOpenBridge } from './native-app/os-markdown-file-open-bridge'
import { registerBotDeepLinkIpcBridge } from './bot-deep-link-ipc-bridge'
import { registerProjectCatalogIpcBridge } from './workspace-catalog/project-catalog-ipc-bridge'
import { registerRateLimitIpcBridge } from './native-app/rate-limit-ipc-bridge'
import { registerClaudeAccountSwitchIpcBridge } from '../../lib/provider-accounts/claude-account-switch-ipc-bridge'
import { registerRuntimeClientIpcBridge } from './runtime-events/runtime-client-ipc-bridge'
import { registerSessionTabIpcBridge } from './session-tabs/session-tab-ipc-bridge'
import { registerSettingsAndSidebarIpcBridge } from '../app-commands/settings-sidebar-ipc-bridge'
import { registerQuitAndStopAllSessionsIpcBridge } from './native-app/quit-and-stop-all-sessions-ipc-bridge'
import { registerBackgroundWorkerPausedIpcBridge } from './native-app/background-worker-paused-ipc-bridge'
import { registerTabLifecycleIpcBridge } from './session-tabs/tab-lifecycle-ipc-bridge'
import { registerTerminalPresentationIpcBridge } from './terminal/terminal-presentation-ipc-bridge'
import { registerTerminalTabMountIpcBridge } from './terminal/terminal-tab-mount-ipc-bridge'
import { registerPtySourceDisownedIpcBridge } from './terminal/pty-source-disowned-ipc-bridge'
import { registerTerminalRequestIpcBridge } from './terminal/terminal-request-ipc-bridge'
import { registerAgentLaunchTabIpcBridge } from '../../lib/agent-session/launch/pane/agent-launch-tab-ipc-bridge'
import { registerTerminalPaneRevealIpcBridge } from './terminal/terminal-pane-reveal-ipc-bridge'
import { registerAgentPaneActivityIpcBridge } from '../../components/activity/paired-clients/agent-pane-activity-ipc-bridge'
import { registerTerminalUiRoutingIpcBridge } from './terminal/terminal-ui-routing-ipc-bridge'
import { registerUpdaterStatusIpcBridge } from './native-app/updater-status-ipc-bridge'
import { createWorktreeEventRuntime } from './workspace-catalog/worktree-event-runtime'
import { registerWorkspaceShortcutIpcBridge } from '../app-commands/workspace-shortcut-ipc-bridge'
import { registerZoomIpcBridge } from './native-app/zoom-ipc-bridge'
import { registerWslAccountNoticeIpcBridge } from '../../runtime/hosts/wsl/wsl-account-notice-ipc-bridge'
import { registerWslHostIpcBridge } from '../../runtime/hosts/wsl/wsl-host-ipc-bridge'
import { noteOrchestrationSessionWorkersChanged } from '@/lib/orchestration-session-workers'

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
  const unsubs: (() => void)[] = [installBrowserInitializationPresentationLifetime()]
  if (window.api.ui.onSleepingMailChanged) {
    unsubs.push(window.api.ui.onSleepingMailChanged((ids) => setSleepingMailWorktrees(ids)))
  }
  const backgroundWakeDispatcher = createBackgroundSleepingAgentWakeDispatcher()
  unsubs.push(backgroundWakeDispatcher.dispose)
  unsubs.push(
    window.api.automations.onChanged((payload) => emitAutomationsChangedWindowEvent(payload))
  )
  // This app's own runtime's bots; a paired server's arrive on its client-event stream.
  unsubs.push(
    window.api.botChanges.onChanged((scope) =>
      emitBotsChangedWindowEvent(LOCAL_EXECUTION_HOST_ID, scope)
    )
  )
  unsubs.push(installBotHostListing(useAppStore, isPairedWebClientWindow()))
  const stopSessionWorkerNotices = window.api.runtime.onOrchestrationSessionWorkersChanged?.(
    ({ sessionId }) => noteOrchestrationSessionWorkersChanged(null, sessionId)
  )
  if (stopSessionWorkerNotices) {
    unsubs.push(stopSessionWorkerNotices)
  }
  unsubs.push(
    window.api.workspaceCleanup.onRunFinished((run) =>
      emitWorkspaceCleanupRunFinishedWindowEvent({ environmentId: null, run })
    )
  )

  const worktreeRuntime = createWorktreeEventRuntime(unsubs, isRuntimeEnvironmentActive)
  const statusApi = window.api.runtimeEnvironments
  if (statusApi?.onStatusChanged) {
    const availableHosts = new Set<string>()
    const apply = (snapshot: RuntimeHostStatusSnapshot): void => {
      if (snapshot.transport === 'ready' && snapshot.verification === 'verified') {
        if (!availableHosts.has(snapshot.environmentId)) {
          availableHosts.add(snapshot.environmentId)
          window.api.ui.notifySleepingMailAvailability?.()
        }
      } else {
        availableHosts.delete(snapshot.environmentId)
      }
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
  registerEphemeralVmLifecycleIpcBridge(unsubs)
  registerProjectCatalogIpcBridge(
    unsubs,
    worktreeRuntime.worktreeChangeRefreshQueue,
    isRuntimeEnvironmentActive,
    remountTerminalTabsAwaitingHostHydration
  )
  registerSettingsAndSidebarIpcBridge(unsubs)
  registerQuitAndStopAllSessionsIpcBridge(unsubs)
  registerBackgroundWorkerPausedIpcBridge(unsubs)
  registerOrcaProfileAuthIpcBridge(unsubs)
  registerPreflightWslRetryIpcBridge(unsubs)
  registerWorkspaceShortcutIpcBridge(unsubs)
  registerOsMarkdownFileOpenBridge(unsubs)
  registerBotDeepLinkIpcBridge(unsubs)
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
  registerTerminalTabMountIpcBridge(unsubs)
  registerTerminalRequestIpcBridge(unsubs)
  registerAgentLaunchTabIpcBridge(unsubs)
  registerPtySourceDisownedIpcBridge(unsubs)
  registerTerminalUiRoutingIpcBridge(unsubs)
  registerTerminalPaneRevealIpcBridge(unsubs)
  registerAgentPaneActivityIpcBridge(unsubs)
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
  registerPluginViewIpcBridge(unsubs)
  registerClaudeAccountSwitchIpcBridge(unsubs)
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
