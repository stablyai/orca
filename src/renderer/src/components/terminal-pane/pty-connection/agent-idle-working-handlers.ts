import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../../../shared/ephemeral-setup-terminal-worktree-id'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { getConnectionId } from '@/lib/connection-context'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { parseAppSshPtyId } from '../../../../../shared/ssh-pty-id'
import { isWebTerminalSurfaceTabId } from '@/runtime/web-terminal-surface-id'
import type { DirectSshPaneRetryAttempt } from '@/store/slices/direct-ssh-terminal-recovery'
import { directSshAuthoritiesEqual } from '@/store/slices/direct-ssh-terminal-authority-ledger'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installAgentIdleWorkingHandlers(session: ConnectPanePtySession): void {
  session.onAgentBecameWorking = (): void => {
    session.suppressNativeWindowsIdleCodexFocusReports = false
    session.clearSuppressedTitleSideEffects()
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.requiresFreshWorkingForAgentTaskCompleteNotification = false
      session.agentCompletionCoordinator.observeTitleWorking()
    }
    // Why: a new API call refreshes the prompt-cache TTL, so clear any running
    // countdown. The timer will restart when the agent becomes idle again.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    session.clearPendingAgentTaskCompleteNotification()
    if (session.pendingTerminalBellNotification) {
      session.scheduleTerminalBellNotification()
    }
  }
  session.onAgentExited = (): void => {
    // Why: eligibility can disappear transiently during reconnect, but a
    // confirmed shell-title transition is authoritative for native-chat exit.
    session.deps.onAgentExitedRef.current(session.pane.leafId)
    session.clearSuppressedTitleSideEffects()
    session.clearCommandInferredPaneAgent()
    session.requestKnownWindowsShiftEnterReconfirmation()
    // Why: when the terminal title reverts to a plain shell (e.g., "bash", "zsh"),
    // the agent has exited. Clear any running cache timer so the sidebar doesn't
    // show a stale countdown for a tab that no longer has an active Claude session.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    session.clearTitleOnlyInterruptTimer()
    // Why: title reversion alone is not process death. The process/PTY tracker
    // owns removing agent rows when the TUI actually exits.
  }
  // Why: inject ORCA_PANE_KEY so global Claude/Codex hooks can attribute their
  // callbacks to the correct Orca pane without resolving worktrees from cwd.
  // The key matches the `${tabId}:${leafId}` composite used for cacheTimerByKey
  // and agentStatusByPaneKey. Treat it as opaque outside Orca.
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

  // Why: folder workspaces can inherit their SSH target from child repos, so
  // use the shared resolver instead of only looking up repo-backed worktrees.
  session.worktree = getWorktreeMapFromState(session.state).get(session.deps.worktreeId)
  session.worktreeConnectionId = getConnectionId(session.deps.worktreeId)
  session.tab = (session.state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
    (t) => t.id === session.deps.tabId
  )
  session.restoredPtyIdForTransport =
    session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
      ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
      : null
  // Why: the floating terminal and inline setup/onboarding terminals are host-agnostic synthetic
  // ids with no worktree/repo row, so the strict owner resolver reports them as unresolved. The
  // shared terminal router scopes them to their floating owner (local for the floating terminal,
  // the active runtime for setup terminals so remote skill installs land there) and returns null
  // only for a genuinely unknown/stale worktree that must fail closed (#9994).
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
  // Why: host-agnostic synthetic ids (floating terminal, inline setup panels) have no repo
  // row by design, and a worktree row stamped 'local' proves its host on its own — both are
  // resolved-local, not pending hydration (#10151). Only when nothing names the host does
  // `undefined` mean the repo hasn't merged yet; coalescing that to null would fail-open a
  // remote cwd onto the local daemon (ENOENT on Docker SSH paths).
  session.hostAgnosticTerminalWorktree =
    session.deps.worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    isEphemeralSetupTerminalWorktreeId(session.deps.worktreeId)
  session.worktreeProvesLocalHost = parseExecutionHostId(session.worktree?.hostId)?.kind === 'local'
  session.connectionOwnerHydrating =
    !session.terminalOwnerUnresolved &&
    !session.hostAgnosticTerminalWorktree &&
    !session.worktreeProvesLocalHost &&
    session.runtimeEnvironmentId === null &&
    session.worktreeConnectionId === undefined
  // Why: an SSH host nested under a HUB is execution identity, not permission for the paired client to dial that host.
  session.connectionId =
    !session.terminalOwnerUnresolved &&
    !session.connectionOwnerHydrating &&
    session.runtimeEnvironmentId === null
      ? (session.worktreeConnectionId ?? null)
      : null
  type DirectSshRetryLease = Pick<
    DirectSshPaneRetryAttempt,
    'attemptId' | 'authority' | 'tabGeneration'
  >
  session.directSshRetryAttempt = (() => {
    const pendingAttempt = session.state.directSshPaneRetryByTabId?.[session.deps.tabId]
    const liveBinding = session.state.directSshLivePtyBindingByTabId?.[session.deps.tabId]
    const attempt =
      pendingAttempt?.authority.targetId === session.connectionId &&
      pendingAttempt.tabGeneration === (session.tab?.generation ?? 0)
        ? pendingAttempt
        : liveBinding?.authority.targetId === session.connectionId &&
            liveBinding.tabGeneration === (session.tab?.generation ?? 0)
          ? liveBinding
          : undefined
    return attempt
  })()
  session.pendingSpawnKey = session.directSshRetryAttempt
    ? JSON.stringify([session.cacheKey, session.directSshRetryAttempt.attemptId])
    : session.cacheKey
  session.capturedDirectSshRetryPtyAccepted = false
  session.directSshPaneRetrySettlementCancelled = false
  session.directSshPaneRetrySettlementTimers = new Set<ReturnType<typeof setTimeout>>()
  session.directSshPaneRetryTimedPromises = new WeakSet<object>()
  session.capturedDirectSshRetryLeaseMatches = (): boolean => {
    if (!session.directSshRetryAttempt) {
      return true
    }
    const currentState = useAppStore.getState()
    const currentConnection = currentState.sshConnectionStates.get(
      session.directSshRetryAttempt.authority.targetId
    )
    const currentTab = (currentState.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (candidate) => candidate.id === session.deps.tabId
    )
    if (
      currentConnection?.providerEpoch !== session.directSshRetryAttempt.authority.providerEpoch ||
      currentConnection?.connectionGeneration !==
        session.directSshRetryAttempt.authority.connectionGeneration ||
      (currentTab?.generation ?? 0) !== session.directSshRetryAttempt.tabGeneration
    ) {
      return false
    }
    const pendingAttempt = currentState.directSshPaneRetryByTabId?.[session.deps.tabId]
    const pendingMatches =
      pendingAttempt?.attemptId === session.directSshRetryAttempt.attemptId &&
      directSshAuthoritiesEqual(
        pendingAttempt.authority,
        session.directSshRetryAttempt.authority
      ) &&
      pendingAttempt.tabGeneration === session.directSshRetryAttempt.tabGeneration
    const liveBinding = currentState.directSshLivePtyBindingByTabId?.[session.deps.tabId]
    const liveBindingMatchesAttempt =
      liveBinding?.attemptId === session.directSshRetryAttempt.attemptId &&
      directSshAuthoritiesEqual(liveBinding.authority, session.directSshRetryAttempt.authority) &&
      liveBinding.tabGeneration === session.directSshRetryAttempt.tabGeneration
    return pendingMatches || liveBindingMatchesAttempt
  }
  session.capturedDirectSshRetryStateMatches = (ptyId: string): boolean => {
    if (!session.directSshRetryAttempt) {
      return true
    }
    const currentConnection = useAppStore
      .getState()
      .sshConnectionStates.get(session.directSshRetryAttempt.authority.targetId)
    return (
      parseAppSshPtyId(ptyId)?.connectionId === session.directSshRetryAttempt.authority.targetId &&
      currentConnection?.status === 'connected' &&
      session.capturedDirectSshRetryLeaseMatches()
    )
  }
  session.claimCapturedDirectSshRetryPty = (ptyId: string): boolean => {
    if (!session.capturedDirectSshRetryStateMatches(ptyId)) {
      return false
    }
    session.capturedDirectSshRetryPtyAccepted = session.directSshRetryAttempt !== undefined
    return true
  }
  session.canAdoptCapturedDirectSshRetryPty = (ptyId: string): boolean => {
    const canAdopt = session.capturedDirectSshRetryStateMatches(ptyId)
    if (canAdopt && session.directSshRetryAttempt) {
      session.capturedDirectSshRetryPtyAccepted = true
    }
    return canAdopt
  }
  session.settleDirectSshPaneRetryAttempt = (
    attempt: DirectSshRetryLease | undefined,
    status: 'failed' | 'timed-out'
  ): void => {
    if (!attempt) {
      return
    }
    useAppStore.getState().settleDirectSshPaneRetry?.({
      status,
      tabId: session.deps.tabId,
      attemptId: attempt.attemptId,
      authority: attempt.authority,
      tabGeneration: attempt.tabGeneration
    })
  }
}
