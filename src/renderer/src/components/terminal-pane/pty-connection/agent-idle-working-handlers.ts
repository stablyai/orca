import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../../../shared/ephemeral-setup-terminal-worktree-id'
import { isLocalExecutionHost } from '../../../../../shared/execution-host'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { getConnectionId } from '@/lib/connection-context'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { isWebTerminalSurfaceTabId } from '../../../../../shared/terminal-surface-id'

import { settleTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installAgentIdleWorkingHandlers(session: ConnectPanePtySession): void {
  session.onAgentBecameWorking = (): void => {
    session.suppressNativeWindowsIdleCodexFocusReports = false
    session.clearSuppressedTitleSideEffects()
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.requiresFreshWorkingForAgentTaskCompleteNotification = false
      session.agentCompletionCoordinator.observeTitleWorking()
    }
    // New API calls refresh cache TTL; restart the countdown only at the next idle transition.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    session.clearPendingAgentTaskCompleteNotification()
    if (session.pendingTerminalBellNotification) {
      session.scheduleTerminalBellNotification()
    }
  }
  session.onAgentExited = (): void => {
    // Transient reconnect ineligibility cannot prevent authoritative shell-title exit from native chat.
    session.deps.onAgentExitedRef.current(session.pane.leafId)
    session.clearSuppressedTitleSideEffects()
    session.clearCommandInferredPaneAgent()
    session.requestKnownWindowsShiftEnterReconfirmation()
    // Clear cache countdown when title returns to shell; process/PTY lifecycle owns actual agent-row removal.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    session.clearTitleOnlyInterruptTimer()
    // Why: title reversion alone is not process death. The process/PTY tracker
    // owns removing agent rows when the TUI actually exits.
  }
  // Inject opaque ORCA_PANE_KEY matching tabId:leafId so global hooks can attribute callbacks without cwd lookup.
  session.state = useAppStore.getState()
  session.parsedWorkspaceKey = parseWorkspaceKey(session.deps.worktreeId)
  session.folderWorkspace =
    session.parsedWorkspaceKey?.type === 'folder'
      ? session.state.folderWorkspaces.find(
          (workspace) => workspace.id === session.parsedWorkspaceKey.folderWorkspaceId
        )
      : null
  session.workspaceEnv = { ORCA_WORKSPACE_ID: session.deps.worktreeId }
  if (session.folderWorkspace) {
    session.workspaceEnv.ORCA_PROJECT_GROUP_ID = session.folderWorkspace.projectGroupId
    session.workspaceEnv.ORCA_WORKSPACE_ROOT = session.folderWorkspace.folderPath
  }
  session.paneIdentityEnv = {
    ...session.workspaceEnv,
    ORCA_PANE_KEY: session.cacheKey,
    ORCA_TAB_ID: session.deps.tabId,
    ORCA_WORKTREE_ID: session.deps.worktreeId,
    ...(session.launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: session.launchToken } : {})
  }
  session.paneEnv = {
    ...session.paneStartup?.env,
    ...session.paneIdentityEnv
  }

  // Folder workspaces can inherit SSH targets from child repos; use the shared resolver.
  session.worktree = getWorktreeMapFromState(session.state).get(session.deps.worktreeId)
  session.worktreeConnectionId = getConnectionId(session.deps.worktreeId)
  session.tab = (session.state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
    (t) => t.id === session.deps.tabId
  )
  session.restoredPtyIdForTransport =
    session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
      ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
      : null
  // Synthetic floating/setup IDs lack catalog rows; shared routing scopes their host and only rejects genuinely unresolved workspaces (#9994).
  session.terminalWorktreeRoute = resolveTerminalWorktreeRoute(
    session.state,
    session.deps.worktreeId
  )
  session.explicitRuntimeEnvironmentId = session.terminalWorktreeRoute?.runtimeEnvironmentId ?? null
  // Why: paired-web worktrees retain HUB execution identity; their runtime-scoped mirrored pane is the session-level transport owner.
  session.mirroredRuntimeOwners = new Set(
    isWebTerminalSurfaceTabId(session.deps.tabId)
      ? [session.restoredPtyIdForTransport, session.tab?.ptyId]
          .map((ptyId) => (ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null))
          .filter((environmentId): environmentId is string => Boolean(environmentId))
      : []
  )
  session.mirroredRuntimeEnvironmentId = session.mirroredRuntimeOwners.values().next().value ?? null
  session.terminalOwnerUnresolved =
    session.mirroredRuntimeOwners.size > 1 ||
    (session.terminalWorktreeRoute === null && !session.mirroredRuntimeEnvironmentId)
  session.runtimeEnvironmentId = session.explicitRuntimeEnvironmentId
    ? session.explicitRuntimeEnvironmentId
    : session.mirroredRuntimeEnvironmentId
      ? session.mirroredRuntimeEnvironmentId
      : null
  // Synthetic IDs and local-stamped rows already resolve; only unnamed hosts await hydration, or remote cwd could fail open to local (#10151).
  session.hostAgnosticTerminalWorktree =
    session.deps.worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    isEphemeralSetupTerminalWorktreeId(session.deps.worktreeId)
  session.worktreeProvesLocalHost = isLocalExecutionHost(session.worktree?.hostId)
  session.connectionOwnerHydrating =
    !session.terminalOwnerUnresolved &&
    !session.hostAgnosticTerminalWorktree &&
    !session.worktreeProvesLocalHost &&
    session.runtimeEnvironmentId === null &&
    session.worktreeConnectionId === undefined
  // HUB-nested SSH identity grants no direct dial authority; unconverted relay rows wait for the overlay to convert and remount.
  session.unservedSshTargetId =
    !session.terminalOwnerUnresolved &&
    !session.connectionOwnerHydrating &&
    session.runtimeEnvironmentId === null
      ? (session.worktreeConnectionId ?? null)
      : null
  // Recovery generations cannot join replaced spawns; StrictMode preserves generation and may share in-flight work.
  session.pendingSpawnKey = JSON.stringify([session.cacheKey, session.tabGeneration])
  session.settlePaneAttachAttempt = (status: 'success' | 'failed' | 'timed-out'): void => {
    settleTerminalPaneRecovery(session.deps.tabId, session.terminalRecoveryGeneration, status)
  }
}
