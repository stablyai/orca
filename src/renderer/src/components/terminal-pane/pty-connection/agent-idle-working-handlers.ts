import { resolveTerminalPaneOwnerContext } from '../terminal-pane-owner-context'
import { useAppStore } from '@/store'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../../../shared/ephemeral-setup-terminal-worktree-id'
import { isLocalExecutionHost } from '../../../../../shared/execution-host'

import { settleTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installAgentIdleWorkingHandlers(session: ConnectPanePtySession): void {
  // Why: inject ORCA_PANE_KEY so global Claude/Codex hooks can attribute their
  // callbacks to the correct Orca pane without resolving worktrees from cwd.
  // The key matches the `${tabId}:${leafId}` composite used for cacheTimerByKey
  // and agentStatusByPaneKey. Treat it as opaque outside Orca.
  session.state = useAppStore.getState()
  session.parsedWorkspaceKey = parseWorkspaceKey(session.deps.worktreeId)
  session.restoredPtyIdForTransport =
    session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
      ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
      : null
  session.terminalWorktreeRoute = resolveTerminalWorktreeRoute(
    session.state,
    session.deps.worktreeId
  )
  session.ownerContext = resolveTerminalPaneOwnerContext(
    session.state,
    session.deps.worktreeId,
    session.deps.tabId,
    session.terminalWorktreeRoute,
    session.restoredPtyIdForTransport
  )
  session.folderWorkspace = session.ownerContext.folderWorkspace
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

  session.worktree = session.ownerContext.worktree
  session.worktreeConnectionId = session.ownerContext.connectionId
  session.tab = session.ownerContext.tab
  session.terminalWorktreeRoute = session.ownerContext.route
  session.explicitRuntimeEnvironmentId = session.terminalWorktreeRoute?.runtimeEnvironmentId ?? null
  session.mirroredRuntimeOwners = session.ownerContext.runtimeOwners
  session.mirroredRuntimeEnvironmentId = session.ownerContext.mirroredRuntimeEnvironmentId
  session.terminalOwnerUnresolved = session.ownerContext.unresolved
  session.runtimeEnvironmentId = session.ownerContext.runtimeEnvironmentId
  // Why: host-agnostic synthetic ids (floating terminal, inline setup panels) have no repo
  // row by design, and a worktree row stamped 'local' proves its host on its own — both are
  // resolved-local, not pending hydration (#10151). Only when nothing names the host does
  // `undefined` mean the repo hasn't merged yet; coalescing that to null would fail-open a
  // remote cwd onto the local daemon (ENOENT on Docker SSH paths).
  session.hostAgnosticTerminalWorktree =
    session.deps.worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    isEphemeralSetupTerminalWorktreeId(session.deps.worktreeId)
  session.worktreeProvesLocalHost =
    isLocalExecutionHost(session.worktree?.hostId) ||
    (session.ownerContext.selectedHost?.kind === 'local' && !!session.worktree)
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
