import {
  presentDesktopWorkspace,
  beginDesktopNavigation,
  canPresentDesktopNavigation
} from './desktop-navigation'
import { activateAndRevealFolderWorkspace } from './folder-workspace-activation'
export { activateAndRevealFolderWorkspace } from './folder-workspace-activation'
import { canInspectAgentActivationInventory } from './worktree-activation-pty-inventory'
import { openDesktopWorkbench } from '@/components/threads/thread-navigation'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'
import { noteUserWorkspaceOpen } from './workspace-switch-user-act'
import { useAppStore } from '@/store'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import { activateWebRuntimeSessionWorktree } from '@/runtime/web-runtime-worktree-activation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { registerWorktreeActivation } from '@/lib/worktree-activation-nav-registration'
import { workspaceHasSleepingAgentSessions } from '@/lib/worktree-agent-activation-gate'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
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
import { buildActivationStateTransition } from './worktree-activation-visit'

/** Share palette/dialog activation; derive repoId and no-op if the selected worktree vanished. */
export type ActivateAndRevealResult = {
  /** Id of the primary terminal tab seeded with `opts.startup`, or null. Prefer this over
   *  `activeTabIdByWorktree`, which may point at another tab if setup/issue scripts opened their own. */
  primaryTabId: string | null
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
  const navigation =
    opts?.navigation === undefined ? beginDesktopNavigation(state) : opts.navigation
  const pendingCreationId = findPendingWorktreeCreationId(state.pendingWorktreeCreations, wt.id)
  // Why: a checkout published mid-create shows its creation progress until that creation hands off.
  if (pendingCreationId && opts?.worktreeCreationId !== pendingCreationId) {
    if (navigation && canPresentDesktopNavigation(navigation)) {
      state.setActivePendingWorktreeCreation(pendingCreationId)
      state.updatePendingWorktreeCreation(pendingCreationId, { loaderVisible: true })
      presentDesktopWorkspace(state, navigation)
    }
    return { primaryTabId: null }
  }
  const hasActivationWork = Boolean(
    opts?.startup || opts?.setup || opts?.defaultTabs || opts?.issueCommand
  )
  if (navigation === null || !canPresentDesktopNavigation(navigation)) {
    const primaryTabId = hasActivationWork
      ? ensureWorktreeHasInitialTerminal(
          state,
          worktreeId,
          opts?.startup,
          opts?.setup,
          opts?.issueCommand,
          opts?.defaultTabs,
          {
            activateCreatedTabs: false,
            callerProvidesSurface: activationProvidesInitialSurface(opts),
            worktreeCreationId: opts?.worktreeCreationId,
            executionHostId: opts?.executionHostId,
            backendStartupTerminalSpawned: opts?.backendStartupTerminalSpawned,
            createNewTerminalForStartup: opts?.createNewTerminalForStartup
          }
        )
      : null
    if (primaryTabId && opts?.initialCwd) {
      state.queueTabInitialCwd(primaryTabId, opts.initialCwd)
    }
    return { primaryTabId }
  }
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
    presentDesktopWorkspace(state, navigation)
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
  }
  if (shouldGateAgentActivation) {
    gateAndReseedEmptyWorkspace(worktreeId, {
      callerProvidesSurface: opts?.providesInitialSurface === true,
      seedUserDefaultSurface,
      navigation,
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
            navigation,
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
      ...(opts && 'runtimeEnvironmentId' in opts
        ? { runtimeEnvironmentId: ownerRuntimeEnvironmentId }
        : {}),
      startup: opts?.startup,
      agent: opts?.agent
    })
  }

  if (opts?.navigationIntent === 'user-open') {
    openDesktopWorkbench(useAppStore.getState(), worktreeId, navigation ?? undefined)
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
