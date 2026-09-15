import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import {
  activateWebRuntimeSessionWorktree,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { registerWorktreeActivation } from '@/lib/worktree-activation-nav-registration'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  folderWorkspaceActivationBlocked,
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from './folder-workspace-path-status'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { findFolderWorkspaceOwner } from './folder-workspace-runtime-owner'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { applyWorktreeNavViewEntry } from '@/lib/worktree-nav-view-history-replay'
import type {
  WorktreeActivationOptions,
  WorktreeActivationSurfaceSelection
} from './worktree-activation-surface-selection'
import { resolveWorkspaceExecutionEvidence } from './workspace-execution-evidence'
import {
  createWorkspaceActivationIdentity,
  ensureFolderWorkspaceInitialTerminal,
  finalizeActivatedWorkspaceSurface,
  hasOutstandingActivationSurfaceProducer,
  hasWorkspaceActivationWork
} from './worktree-activation-recovery-routing'
import { produceRequestedWorkspaceSurface } from './workspace-activation-requested-surface'
import {
  clearWorktreeActivationSidebarFilters,
  revealActivatedWorktree
} from './worktree-activation-sidebar-filters'

/**
 * Shared activation sequence used by the worktree palette and add-repo/worktree dialogs.
 * The caller passes only `worktreeId`; the helper derives `repoId` and returns early
 * without side effects if the worktree is not found (deleted between palette open and select).
 */
export type ActivateAndRevealResult = {
  /** Id of the primary terminal tab seeded with `opts.startup`, or null. Prefer this over
   *  `activeTabIdByWorktree`, which may point at another tab if setup/issue scripts opened their own. */
  primaryTabId: string | null
}

export function activateAndRevealFolderWorkspace(
  folderWorkspaceId: string,
  opts?: WorktreeActivationSurfaceSelection & {
    sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
    revealInSidebar?: boolean
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
  const folderWorkspace = state.folderWorkspaces.find(
    (workspace) => workspace === folderWorkspaceOwner
  )
  if (!folderWorkspace) {
    return false
  }
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : getRuntimeEnvironmentIdForWorktree(state, folderWorkspaceKey(folderWorkspaceId))
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

  state.setActiveFolderWorkspace(folderWorkspaceId, opts?.executionHostId)

  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  state.markWorktreeVisited(workspaceKey)
  if (!state.isNavigatingHistory) {
    state.recordWorktreeVisit(workspaceKey)
  }
  const identity = createWorkspaceActivationIdentity(workspaceKey, {
    ...(opts?.executionHostId ? { executionHostId: opts.executionHostId } : {}),
    runtimeEnvironmentId
  })
  const executionEvidence = resolveWorkspaceExecutionEvidence(
    useAppStore.getState(),
    workspaceKey,
    identity.executionHostId
  )
  const delegatesToRuntime =
    executionEvidence === 'live' && isWebRuntimeSessionActive(runtimeEnvironmentId)
  let primaryTabId: string | null = null
  if (opts?.startup && !delegatesToRuntime) {
    primaryTabId = produceRequestedWorkspaceSurface({
      identity,
      executionEvidence,
      owner: 'local',
      createSurface: (hostAbsenceConfirmed) =>
        ensureFolderWorkspaceInitialTerminal(folderWorkspace, opts.startup, hostAbsenceConfirmed)
    })
  }
  if (opts?.revealInSidebar !== false) {
    state.revealWorktreeInSidebar(
      workspaceKey,
      opts?.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : undefined
    )
  }

  if (!hasOutstandingActivationSurfaceProducer(identity)) {
    ensureWebRuntimeWorktreeTerminalAfterWake(workspaceKey, {
      runtimeEnvironmentId,
      startup: opts?.startup,
      agent: opts?.agent
    })
  }
  return { primaryTabId: finalizeActivatedWorkspaceSurface(identity, primaryTabId) }
}

export function activateAndRevealWorktree(
  worktreeId: string,
  opts?: WorktreeActivationOptions
): ActivateAndRevealResult | false {
  const state = useAppStore.getState()
  const wt = state.getKnownWorktreeById(worktreeId, opts?.executionHostId)
  if (!wt) {
    return false
  }
  const hasActivationWork = hasWorkspaceActivationWork(opts)
  // Why: a plain reselect should still reveal the sidebar row but must not restamp focus recency or wake persistence.
  const isPlainAlreadyActiveTerminal =
    !hasActivationWork &&
    state.activeRepoId === wt.repoId &&
    state.activeWorktreeId === worktreeId &&
    state.activeWorkspaceExecutionHostId === (opts?.executionHostId ?? null) &&
    state.activeView === 'terminal'

  // 1. Set activeRepoId if crossing repos
  if (wt.repoId !== state.activeRepoId) {
    state.setActiveRepo(wt.repoId)
  }

  // 2. Switch any non-terminal view back to terminal
  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }

  // 3. Core activation: setActiveWorktree also restores per-worktree state, clears unread, bumps dead PTY generations, refreshes GitHub
  state.setActiveWorktree(worktreeId, opts?.executionHostId)
  const postActivationState = useAppStore.getState()
  const ownerRuntimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(postActivationState, wt.id)
  if (opts?.notifyHostRuntime !== false && isWebRuntimeSessionActive(ownerRuntimeEnvironmentId)) {
    // Why: paired web clients own only local selection, so the desktop host publishes session surfaces without treating it as a nav command.
    void activateWebRuntimeSessionWorktree({
      worktreeId,
      environmentId: ownerRuntimeEnvironmentId
    })
  }

  // Why: focus recency for Cmd+J ordering, distinct from recordWorktreeVisit/lastActivityAt; stamp before any later async step could throw. See docs/cmd-j-empty-query-ordering.md.
  if (!isPlainAlreadyActiveTerminal) {
    state.markWorktreeVisited(worktreeId)
  }

  // Why: skip re-recording for goBack/goForward history navigation — it moves the index instead of visiting anew (isNavigatingHistory).
  if (!isPlainAlreadyActiveTerminal && !state.isNavigatingHistory) {
    state.recordWorktreeVisit(worktreeId)
  }

  // Concrete launch work keeps its existing synchronous producer; empty activation is assessed by
  // the recovery owner, which reconciles sleeping, structured, and live host inventory first.
  const identity = createWorkspaceActivationIdentity(
    worktreeId,
    opts?.executionHostId ? { executionHostId: opts.executionHostId } : undefined
  )
  const executionEvidence = resolveWorkspaceExecutionEvidence(
    postActivationState,
    worktreeId,
    identity.executionHostId
  )
  const delegatesToRuntime =
    executionEvidence === 'live' && isWebRuntimeSessionActive(ownerRuntimeEnvironmentId)
  let primaryTabId: string | null = null
  if (hasActivationWork) {
    // Why: sleeping destroys the local PTY but preserves the provider session id, so waking should
    // restore those CLI sessions. Ordering is load-bearing: resuming synchronously creates the
    // session's tab first, so the seeding below doesn't add a bare shell next to it.
    primaryTabId = produceRequestedWorkspaceSurface({
      identity,
      executionEvidence,
      owner: delegatesToRuntime
        ? 'runtime-transfer'
        : opts?.backendStartupTerminalSpawned
          ? 'backend-confirmed'
          : 'local',
      createSurface: (hostAbsenceConfirmed) =>
        ensureWorktreeHasInitialTerminal(
          useAppStore.getState(),
          worktreeId,
          opts?.startup,
          opts?.setup,
          opts?.issueCommand,
          opts?.defaultTabs,
          {
            ...(opts?.backendStartupTerminalSpawned ? { backendStartupTerminalSpawned: true } : {}),
            ...(opts?.createNewTerminalForStartup ? { createNewTerminalForStartup: true } : {}),
            reseedEmptiedWorkspace: true,
            hostAbsenceConfirmed
          }
        )
    })
  }
  // 5. Clear sidebar filters hiding the target — reveal needs the card rendered, else it silently no-ops.
  if (opts?.clearSidebarFilters !== false) {
    clearWorktreeActivationSidebarFilters(state, wt)
  }

  // 6. Reveal in sidebar
  if (opts?.revealInSidebar !== false) {
    revealActivatedWorktree(state, worktreeId, {
      ...(opts?.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : {}),
      ...(opts?.executionHostId ? { executionHostId: opts.executionHostId } : {})
    })
  }

  if (
    opts?.notifyHostRuntime !== false &&
    !opts?.backendStartupTerminalSpawned &&
    !hasOutstandingActivationSurfaceProducer(identity)
  ) {
    ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId, {
      startup: opts?.startup,
      agent: opts?.agent
    })
  }
  return {
    primaryTabId: finalizeActivatedWorkspaceSurface(identity, primaryTabId, opts?.initialCwd)
  }
}

/**
 * Activates a sidebar workspace id of either shape. Rendered sidebar order mixes
 * plain worktree ids with `folder:` keys, so every caller that navigates by that
 * order must dispatch here — the folder branch is what enforces the path-status
 * gate that blocks a missing/unmounted/disconnected-SSH folder (#10716).
 */
export function activateAndRevealWorkspace(
  workspaceId: string,
  opts?: WorktreeActivationSurfaceSelection & {
    executionHostId?: ExecutionHostId
    revealInSidebar?: boolean
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

// Why: break the import cycle — nav-history slice (under @/store) can't import activation directly, so register the activator here.
registerWorktreeActivation(activateAndRevealWorkspace, applyWorktreeNavViewEntry)
