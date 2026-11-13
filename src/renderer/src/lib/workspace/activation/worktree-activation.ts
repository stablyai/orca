import { isWorktreeRetiredByRemoval } from '../../../../../shared/worktree/removal-visibility'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../ownership/worktree-runtime-owner'
import { noteUserWorkspaceOpen } from './workspace-switch-user-act'
import { useAppStore } from '@/store/index'
import { activateWebRuntimeSessionWorktree } from '@/runtime/web-session-tabs-sync/actions/web-runtime-worktree-activation'
import { isWebRuntimeSessionActive } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { registerWorktreeActivation } from '@/lib/workspace/activation/worktree-activation-nav-registration'
import { workspaceHasSleepingAgentSessions } from '@/lib/workspace/activation/worktree-agent-activation-gate'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/agent-session/resume/resume-sleeping-agent-session'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { notifyBlockedFolderWorkspacePath } from '../paths/folder-workspace-path-status'
import { blocksFolderWorkspaceActivation } from '../../../../../shared/folder-workspaces/folder-workspace-path-status'
import {
  findFolderWorkspaceOwner,
  getRuntimeEnvironmentIdForFolderWorkspace
} from '../ownership/folder-workspace-runtime-owner'
import '../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../../shared/folder-workspaces/folder-workspace-host-id'
import {
  ensureFolderWorkspaceInitialTerminal,
  ensureWorktreeHasInitialTerminal
} from '@/lib/workspace/activation/initial-surface/worktree-initial-terminal-seeding'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/runtime/hosted-terminals/restoration/web-runtime-worktree-terminal-after-wake'
import { applyWorktreeNavViewEntry } from '@/lib/workspace/activation/worktree-nav-view-history-replay'
import {
  activationProvidesInitialSurface,
  activationSeedsUserDefaultSurface,
  type WorktreeActivationOptions
} from './worktree-activation-surface-selection'
import { gateAndReseedEmptyWorkspace } from './worktree-activation-gated-empty-reseed'
import {
  isWorktreeInHiddenProject,
  liftSidebarFiltersHidingWorktree
} from './worktree-activation-sidebar-filters'
import { isFloatingWorkspaceId } from '../../../../../shared/floating-workspace-worktree'
import { revealFloatingWorkspacePanel } from '../../../components/floating-terminal/floating-workspace-panel-reveal'
import { findPendingWorktreeCreationId } from '../creation/pending-worktree-creation'
import {
  buildActivationStateTransition,
  markVisited,
  readPreviousActive,
  recordShownTabFocus
} from './worktree-activation-visit'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'

import {
  workspaceActivationResult,
  type WorkspaceActivationOutcome,
  type FolderWorkspaceActivationOptions,
  type WorkspaceRevealOptions
} from '@/lib/workspace/activation/worktree-activation-outcome'

const canInspectAgentActivationInventory = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.api?.runtime?.call === 'function' &&
  typeof window.api?.pty?.listSessions === 'function'

export function activateAndRevealFolderWorkspaceWithOutcome(
  folderWorkspaceId: string,
  opts?: FolderWorkspaceActivationOptions
): WorkspaceActivationOutcome {
  const state = useAppStore.getState()
  const folderWorkspaceOwner = findFolderWorkspaceOwner(
    state,
    folderWorkspaceId,
    opts?.executionHostId
  )
  const folderWorkspace = selectFolderWorkspaces(state).find(
    (workspace) => workspace === folderWorkspaceOwner
  )
  if (!folderWorkspace) {
    return { refused: { reason: 'workspace-missing', failureNotified: false } }
  }
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : getRuntimeEnvironmentIdForFolderWorkspace(state, folderWorkspaceId, opts?.executionHostId)
  const pathStatus = state.getFreshFolderWorkspacePathStatus(
    {
      scope: 'folder-workspace',
      folderWorkspaceId
    },
    { runtimeEnvironmentId }
  )
  if (blocksFolderWorkspaceActivation(pathStatus)) {
    notifyBlockedFolderWorkspacePath(pathStatus, folderWorkspace.folderPath)
    return { refused: { reason: 'path-blocked', failureNotified: true } }
  }

  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }

  const previousActive = readPreviousActive(state)
  state.setActiveFolderWorkspace(folderWorkspaceId, opts?.executionHostId)

  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  const providesInitialSurface = activationProvidesInitialSurface(opts)
  const seedUserDefaultSurface = activationSeedsUserDefaultSurface(opts)
  markVisited(state, workspaceKey, previousActive, opts?.executionHostId, opts?.navigationIntent)
  if (!state.isNavigatingHistory) {
    state.recordWorktreeVisit(workspaceKey)
  }
  // Why: same ordering as the worktree path — gate first, then resume only when not deferring.
  const shouldGateAgentActivation =
    !opts?.startup &&
    (workspaceHasSleepingAgentSessions(state, workspaceKey) ||
      (canInspectAgentActivationInventory() &&
        shouldAutoCreateInitialTerminal(
          state.reconcileWorktreeTabModel(workspaceKey).renderableTabCount
        )))
  if (!shouldGateAgentActivation) {
    resumeSleepingAgentSessionsForWorktree(workspaceKey)
  } else {
    gateAndReseedEmptyWorkspace(workspaceKey, {
      callerProvidesSurface: opts?.providesInitialSurface === true,
      seedUserDefaultSurface,
      ...(opts?.executionHostId ? { executionHostId: opts.executionHostId } : {})
    })
  }
  const primaryTabId = shouldGateAgentActivation
    ? null
    : ensureFolderWorkspaceInitialTerminal(folderWorkspace, opts?.startup, providesInitialSurface, {
        seedUserDefaultSurface
      })

  if (opts?.showWorkspaceList) {
    state.setSidebarBody('workspaces')
  }
  if (opts?.revealInSidebar !== false) {
    state.revealWorktreeInSidebar(workspaceKey, {
      executionHostId:
        opts?.executionHostId ?? getFolderWorkspaceHostId(folderWorkspace, state.projectGroups),
      ...(opts?.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : {})
    })
  }

  if (opts?.providesInitialSurface !== true) {
    ensureWebRuntimeWorktreeTerminalAfterWake(workspaceKey, {
      runtimeEnvironmentId,
      startup: opts?.startup,
      agent: opts?.agent
    })
  }
  recordShownTabFocus(useAppStore.getState(), workspaceKey)

  return { opened: { primaryTabId } }
}

export function activateAndRevealWorktreeWithOutcome(
  worktreeId: string,
  opts?: WorktreeActivationOptions
): WorkspaceActivationOutcome {
  const state = useAppStore.getState()
  // The floating workspace owns a separate panel, never the main window's selection.
  if (isFloatingWorkspaceId(worktreeId)) {
    revealFloatingWorkspacePanel(state)
    return { opened: { primaryTabId: null } }
  }
  const wt = state.getKnownWorktreeById(worktreeId, opts?.executionHostId)
  if (!wt || isWorktreeRetiredByRemoval(wt)) {
    return { refused: { reason: 'workspace-missing', failureNotified: false } }
  }
  const pendingCreationId = findPendingWorktreeCreationId(state.pendingWorktreeCreations, wt.id)
  // Why: a checkout published mid-create shows its creation progress until that creation hands off.
  if (pendingCreationId && opts?.worktreeCreationId !== pendingCreationId) {
    state.setActivePendingWorktreeCreation(pendingCreationId)
    state.updatePendingWorktreeCreation(pendingCreationId, { loaderVisible: true })
    state.setActiveView('terminal')
    return { opened: { primaryTabId: null } }
  }
  const hasActivationWork = Boolean(
    opts?.startup || opts?.setup || opts?.defaultTabs || opts?.issueCommand
  )
  const providesInitialSurface = activationProvidesInitialSurface(opts)
  const seedUserDefaultSurface = activationSeedsUserDefaultSurface(opts)
  // Why: a plain reselect should still reveal the sidebar row but must not restamp focus recency or wake persistence.
  const isPlainAlreadyActiveTerminal =
    !hasActivationWork &&
    state.activeRepoId === wt.repoId &&
    state.activeWorktreeId === worktreeId &&
    state.activeWorkspaceExecutionHostId === (opts?.executionHostId ?? null) &&
    state.activeView === 'terminal'

  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }
  noteUserWorkspaceOpen(worktreeId, opts?.navigationIntent)

  state.setActiveWorktree(
    worktreeId,
    opts?.executionHostId,
    buildActivationStateTransition(state, worktreeId, {
      repoId: wt.repoId,
      // Why: Cmd+J focus recency (docs/cmd-j-empty-query-ordering.md); a plain reselect must not restamp it.
      stampsVisit: !isPlainAlreadyActiveTerminal,
      nextHostId: opts?.executionHostId ?? null
    })
  )
  const postActivationState = useAppStore.getState()
  const ownerRuntimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : runtimeEnvironmentIdOrLocalUnlessTwin(postActivationState, wt.id)
  if (opts?.notifyHostRuntime !== false && isWebRuntimeSessionActive(ownerRuntimeEnvironmentId)) {
    // Why: paired web clients own only local selection, so the desktop host publishes session surfaces without treating it as a nav command.
    void activateWebRuntimeSessionWorktree({
      worktreeId,
      environmentId: ownerRuntimeEnvironmentId
    })
  }

  // Decide gate before resuming: resume consumes sleeping evidence, and late structured inventory can otherwise authorize a shell beside a pending chat (STA-1111).
  const shouldGateAgentActivation =
    !hasActivationWork &&
    (workspaceHasSleepingAgentSessions(postActivationState, worktreeId) ||
      (canInspectAgentActivationInventory() &&
        shouldAutoCreateInitialTerminal(
          postActivationState.reconcileWorktreeTabModel(worktreeId).renderableTabCount
        )))
  if (!shouldGateAgentActivation) {
    // Resume preserved provider sessions before shell seeding; synchronous tab creation prevents an extra bare shell.
    resumeSleepingAgentSessionsForWorktree(worktreeId)
  } else {
    gateAndReseedEmptyWorkspace(worktreeId, {
      callerProvidesSurface: opts?.providesInitialSurface === true,
      seedUserDefaultSurface,
      ...(opts?.initialCwd ? { initialCwd: opts.initialCwd } : {}),
      ...(opts?.executionHostId ? { executionHostId: opts.executionHostId } : {})
    })
  }

  const primaryTabId =
    shouldGateAgentActivation || (providesInitialSurface && !hasActivationWork)
      ? null
      : ensureWorktreeHasInitialTerminal(
          useAppStore.getState(),
          worktreeId,
          opts?.startup,
          opts?.setup,
          opts?.issueCommand,
          opts?.defaultTabs,
          {
            ...(opts?.worktreeCreationId ? { worktreeCreationId: opts.worktreeCreationId } : {}),
            ...(opts?.backendStartupTerminalSpawned ? { backendStartupTerminalSpawned: true } : {}),
            ...(opts?.createNewTerminalForStartup ? { createNewTerminalForStartup: true } : {}),
            ...(providesInitialSurface ? { callerProvidesSurface: true } : {}),
            ...(seedUserDefaultSurface ? { seedUserDefaultSurface: true } : {}),
            ...(opts?.initialCwd ? { initialCwd: opts.initialCwd } : {}),
            reseedEmptiedWorkspace: !providesInitialSurface
          }
        )
  if (primaryTabId && opts?.initialCwd) {
    useAppStore.getState().queueTabInitialCwd(primaryTabId, opts.initialCwd)
  }

  if (opts?.showWorkspaceList) {
    state.setSidebarBody('workspaces')
  }
  // No sidebar card to reveal; lifting filters for it would only discard the user's.
  const inHiddenProject = isWorktreeInHiddenProject(wt)
  if (opts?.clearSidebarFilters !== false && !inHiddenProject) {
    liftSidebarFiltersHidingWorktree(wt)
  }

  if (opts?.revealInSidebar !== false && !inHiddenProject) {
    if (opts?.sidebarRevealBehavior || opts?.executionHostId) {
      state.revealWorktreeInSidebar(worktreeId, {
        ...(opts.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : {}),
        ...(opts.executionHostId ? { executionHostId: opts.executionHostId } : {})
      })
    } else {
      state.revealWorktreeInSidebar(worktreeId)
    }
  }

  const startupAccepted =
    opts?.notifyHostRuntime !== false &&
    !opts?.backendStartupTerminalSpawned &&
    opts?.providesInitialSurface !== true &&
    ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId, {
      ...(opts && 'runtimeEnvironmentId' in opts
        ? { runtimeEnvironmentId: ownerRuntimeEnvironmentId }
        : {}),
      startup: opts?.startup,
      agent: opts?.agent
    })
  recordShownTabFocus(useAppStore.getState(), worktreeId)

  return { opened: { primaryTabId, ...(startupAccepted ? { startupAccepted } : {}) } }
}

/** Dispatch sidebar IDs through folder/worktree entry points; folder routing enforces missing/unmounted/disconnected path guards (#10716). */
export function activateAndRevealWorkspaceWithOutcome(
  workspaceId: string,
  opts?: WorkspaceRevealOptions
): WorkspaceActivationOutcome {
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type !== 'folder') {
    return activateAndRevealWorktreeWithOutcome(workspaceId, opts)
  }
  return activateAndRevealFolderWorkspaceWithOutcome(workspaceScope.folderWorkspaceId, opts)
}

export function activateAndRevealFolderWorkspace(
  ...args: Parameters<typeof activateAndRevealFolderWorkspaceWithOutcome>
) {
  return workspaceActivationResult(activateAndRevealFolderWorkspaceWithOutcome(...args))
}

export function activateAndRevealWorktree(
  ...args: Parameters<typeof activateAndRevealWorktreeWithOutcome>
) {
  return workspaceActivationResult(activateAndRevealWorktreeWithOutcome(...args))
}

export function activateAndRevealWorkspace(
  ...args: Parameters<typeof activateAndRevealWorkspaceWithOutcome>
) {
  return workspaceActivationResult(activateAndRevealWorkspaceWithOutcome(...args))
}

// Register here to avoid the @/store nav-history → activation import cycle.
registerWorktreeActivation(activateAndRevealWorkspace, applyWorktreeNavViewEntry)
