import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import { activateWebRuntimeSessionWorktree } from '@/runtime/web-runtime-worktree-activation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { registerWorktreeActivation } from '@/lib/worktree-activation-nav-registration'
import { workspaceHasSleepingAgentSessions } from '@/lib/worktree-agent-activation-gate'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  folderWorkspaceActivationBlocked,
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from './folder-workspace-path-status'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  findFolderWorkspaceOwner,
  getRuntimeEnvironmentIdForFolderWorkspace
} from './folder-workspace-runtime-owner'
import { getFolderWorkspaceHostId } from '../../../shared/folder-workspace-execution-host'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import {
  ensureFolderWorkspaceInitialTerminal,
  ensureWorktreeHasInitialTerminal
} from '@/lib/worktree-initial-terminal-seeding'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { applyWorktreeNavViewEntry } from '@/lib/worktree-nav-view-history-replay'
import {
  activationProvidesInitialSurface,
  activationSeedsUserDefaultSurface,
  type WorktreeActivationOptions,
  type WorktreeActivationSurfaceSelection
} from './worktree-activation-surface-selection'
import { gateAndReseedEmptyWorkspace } from './worktree-activation-gated-empty-reseed'
import { liftSidebarFiltersHidingWorktree } from './worktree-activation-sidebar-filters'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { revealFloatingWorkspacePanel } from './floating-workspace-panel-reveal'
import { findPendingWorktreeCreationId } from './pending-worktree-creation'
import { markVisited, readPreviousActive } from './worktree-activation-visit'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

/** Share palette/dialog activation; derive repoId and no-op if the selected worktree vanished. */
export type ActivateAndRevealResult = {
  /** Id of the primary terminal tab seeded with `opts.startup`, or null. Prefer this over
   *  `activeTabIdByWorktree`, which may point at another tab if setup/issue scripts opened their own. */
  primaryTabId: string | null
}

function canInspectAgentActivationInventory(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.api?.runtime?.call === 'function' &&
    typeof window.api?.pty?.listSessions === 'function'
  )
}

export function activateAndRevealFolderWorkspace(
  folderWorkspaceId: string,
  opts?: WorktreeActivationSurfaceSelection & {
    sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
    revealInSidebar?: boolean
    showWorkspaceList?: boolean
    startup?: WorktreeStartupPayload
    runtimeEnvironmentId?: string | null
    executionHostId?: ExecutionHostId
  }
): ActivateAndRevealResult | false {
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
    return false
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
  if (folderWorkspaceActivationBlocked(pathStatus)) {
    const title =
      getFolderWorkspacePathStatusTitle(pathStatus) ??
      translate(
        'auto.lib.worktree.activation.cannotOpenFolderWorkspace',
        'Cannot open folder workspace'
      )
    toast.error(title, {
      description: getFolderWorkspacePathStatusDescription(pathStatus) ?? folderWorkspace.folderPath
    })
    return false
  }

  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }

  const previousActive = readPreviousActive(state)
  state.setActiveFolderWorkspace(folderWorkspaceId, opts?.executionHostId)

  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  const providesInitialSurface = activationProvidesInitialSurface(opts)
  const seedUserDefaultSurface = activationSeedsUserDefaultSurface(opts)
  markVisited(state, workspaceKey, previousActive, opts?.executionHostId)
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
  }
  if (shouldGateAgentActivation) {
    gateAndReseedEmptyWorkspace(workspaceKey, {
      callerProvidesSurface: opts?.providesInitialSurface === true,
      seedUserDefaultSurface,
      ...(opts?.executionHostId ? { executionHostId: opts.executionHostId } : {})
    })
  }
  const primaryTabId = shouldGateAgentActivation
    ? null
    : ensureFolderWorkspaceInitialTerminal(
        folderWorkspace,
        opts?.startup,
        providesInitialSurface,
        seedUserDefaultSurface
      )

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

  return { primaryTabId }
}

export function activateAndRevealWorktree(
  worktreeId: string,
  opts?: WorktreeActivationOptions
): ActivateAndRevealResult | false {
  const state = useAppStore.getState()
  // The floating workspace owns a separate panel, never the main window's selection.
  if (isFloatingWorkspaceId(worktreeId)) {
    revealFloatingWorkspacePanel(state)
    return { primaryTabId: null }
  }
  const wt = state.getKnownWorktreeById(worktreeId, opts?.executionHostId)
  if (!wt) {
    return false
  }
  const pendingCreationId = findPendingWorktreeCreationId(state.pendingWorktreeCreations, wt.id)
  // Why: a checkout published mid-create shows its creation progress until that creation hands off.
  if (pendingCreationId && opts?.worktreeCreationId !== pendingCreationId) {
    state.setActivePendingWorktreeCreation(pendingCreationId)
    state.updatePendingWorktreeCreation(pendingCreationId, { loaderVisible: true })
    state.setActiveView('terminal')
    return { primaryTabId: null }
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

  if (wt.repoId !== state.activeRepoId) {
    state.setActiveRepo(wt.repoId)
  }

  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }

  const previousActive = readPreviousActive(state)
  state.setActiveWorktree(worktreeId, opts?.executionHostId)
  const postActivationState = useAppStore.getState()
  const ownerRuntimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(
    postActivationState,
    wt.id
  )
  if (opts?.notifyHostRuntime !== false && isWebRuntimeSessionActive(ownerRuntimeEnvironmentId)) {
    // Why: paired web clients own only local selection, so the desktop host publishes session surfaces without treating it as a nav command.
    void activateWebRuntimeSessionWorktree({
      worktreeId,
      environmentId: ownerRuntimeEnvironmentId
    })
  }

  // Why: focus recency for Cmd+J ordering, distinct from recordWorktreeVisit/lastActivityAt; stamp before any later async step could throw. See docs/cmd-j-empty-query-ordering.md.
  if (!isPlainAlreadyActiveTerminal) {
    markVisited(state, worktreeId, previousActive, opts?.executionHostId ?? null)
  }

  // Why: skip re-recording for goBack/goForward history navigation — it moves the index instead of visiting anew (isNavigatingHistory).
  if (!isPlainAlreadyActiveTerminal && !state.isNavigatingHistory) {
    state.recordWorktreeVisit(worktreeId)
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
  }
  if (shouldGateAgentActivation) {
    gateAndReseedEmptyWorkspace(worktreeId, {
      callerProvidesSurface: opts?.providesInitialSurface === true,
      seedUserDefaultSurface,
      ...(opts?.executionHostId ? { executionHostId: opts.executionHostId } : {})
    })
  }

  const primaryTabId = shouldGateAgentActivation
    ? null
    : providesInitialSurface && !hasActivationWork
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
            reseedEmptiedWorkspace: !providesInitialSurface
          }
        )
  if (primaryTabId && opts?.initialCwd) {
    useAppStore.getState().queueTabInitialCwd(primaryTabId, opts.initialCwd)
  }

  if (opts?.showWorkspaceList) {
    state.setSidebarBody('workspaces')
  }
  if (opts?.clearSidebarFilters !== false) {
    liftSidebarFiltersHidingWorktree(wt)
  }

  if (opts?.revealInSidebar !== false) {
    if (opts?.sidebarRevealBehavior || opts?.executionHostId) {
      state.revealWorktreeInSidebar(worktreeId, {
        ...(opts.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : {}),
        ...(opts.executionHostId ? { executionHostId: opts.executionHostId } : {})
      })
    } else {
      state.revealWorktreeInSidebar(worktreeId)
    }
  }

  if (
    opts?.notifyHostRuntime !== false &&
    !opts?.backendStartupTerminalSpawned &&
    opts?.providesInitialSurface !== true
  ) {
    ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId, {
      startup: opts?.startup,
      agent: opts?.agent
    })
  }

  return { primaryTabId }
}

/** Dispatch sidebar IDs through folder/worktree entry points; folder routing enforces missing/unmounted/disconnected path guards (#10716). */
export function activateAndRevealWorkspace(
  workspaceId: string,
  opts?: WorktreeActivationSurfaceSelection & {
    executionHostId?: ExecutionHostId
    sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
    revealInSidebar?: boolean
    showWorkspaceList?: boolean
    /** Worktree-only: folder workspaces are never filter-hidden. */
    clearSidebarFilters?: boolean
  }
): ActivateAndRevealResult | false {
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type !== 'folder') {
    return activateAndRevealWorktree(workspaceId, opts)
  }
  return activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, opts)
}

// Register here to avoid the @/store nav-history → activation import cycle.
registerWorktreeActivation(activateAndRevealWorkspace, applyWorktreeNavViewEntry)
