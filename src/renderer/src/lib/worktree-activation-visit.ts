import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import type { AppState } from '@/store/types'
import type { ActiveWorktreeStateTransition } from '@/store/slices/worktree-helpers'
import { stampWorktreeVisit } from '@/store/slices/worktrees/session/worktree-visit-recency'
import { appendHistoryEntry } from '@/store/slices/worktree-nav-history'
import { noteUserWorkspaceOpen } from './workspace-switch-user-act'

type PreviousActive = { worktreeId: string | null; hostId: ExecutionHostId | null }
type VisitState = Pick<
  AppState,
  'activeWorktreeId' | 'activeWorkspaceExecutionHostId' | 'markWorktreeVisited'
>

export function readPreviousActive(state: VisitState): PreviousActive {
  return { worktreeId: state.activeWorktreeId, hostId: state.activeWorkspaceExecutionHostId }
}

/** Arguments of one markWorktreeVisited call. */
type VisitStamp = Parameters<AppState['markWorktreeVisited']>

/** The recency stamps opening `workspaceId` writes, in write order. */
export function visitStampsFor(
  workspaceId: string,
  previous: PreviousActive,
  nextHostId?: ExecutionHostId | null
): VisitStamp[] {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return [[workspaceId]]
  }
  // Switch point: terminals no longer stamp Recent, so leaving a workspace marks it used up to now.
  const visitedAt = Date.now()
  // The same repoId::path on another host is another workspace.
  const left =
    previous.worktreeId !== null &&
    (previous.worktreeId !== workspaceId ||
      (nextHostId !== undefined && previous.hostId !== nextHostId))
  const stamps: VisitStamp[] = []
  if (left && previous.worktreeId) {
    stamps.push([previous.worktreeId, visitedAt - 1, previous.hostId ?? undefined])
  }
  stamps.push([workspaceId, visitedAt])
  return stamps
}

/** Stamps focus recency for the workspace being opened; `nextHostId` when the caller names one. */
export function markVisited(
  state: VisitState,
  workspaceId: string,
  previous: PreviousActive,
  nextHostId?: ExecutionHostId | null,
  /** 'user-open': the user's own open, which may start a stopped WSL distro (E9). */
  navigationIntent?: 'user-open'
): void {
  noteUserWorkspaceOpen(workspaceId, navigationIntent)
  for (const stamp of visitStampsFor(workspaceId, previous, nextHostId)) {
    state.markWorktreeVisited(...stamp)
  }
}

/** Recency stamps as markVisited writes them after activation: resolved against the post-activation selection. */
function stampActivationVisits(
  current: AppState,
  worktreeId: string,
  previousActive: PreviousActive,
  nextHostId: ExecutionHostId | null
): AppState['lastVisitedAtByWorktreeId'] {
  const visitState = {
    lastVisitedAtByWorktreeId: current.lastVisitedAtByWorktreeId,
    activeWorktreeId: worktreeId,
    activeWorkspaceExecutionHostId: nextHostId,
    getKnownWorktreeById: current.getKnownWorktreeById
  }
  for (const stamp of visitStampsFor(worktreeId, previousActive, nextHostId)) {
    visitState.lastVisitedAtByWorktreeId = stampWorktreeVisit(visitState, ...stamp)
  }
  return visitState.lastVisitedAtByWorktreeId
}

// A de-duplicated append returns the whole input state; spreading it would undo the fresh visit stamps.
function historyPatch({
  worktreeNavHistory,
  worktreeNavHistoryIndex
}: Pick<AppState, 'worktreeNavHistory' | 'worktreeNavHistoryIndex'>): Pick<
  AppState,
  'worktreeNavHistory' | 'worktreeNavHistoryIndex'
> {
  return { worktreeNavHistory, worktreeNavHistoryIndex }
}

/** Folds the repo follow, recency stamps and nav-history entry into the activation write: each store write re-runs every subscriber's selector. */
export function buildActivationStateTransition(
  state: VisitState & Pick<AppState, 'activeRepoId' | 'isNavigatingHistory'>,
  worktreeId: string,
  args: { repoId: string; stampsVisit: boolean; nextHostId: ExecutionHostId | null }
): { stateTransition: ActiveWorktreeStateTransition } | undefined {
  const { stampsVisit, nextHostId } = args
  const repoId = args.repoId === state.activeRepoId ? null : args.repoId
  if (repoId === null && !stampsVisit) {
    return undefined
  }
  const previousActive = readPreviousActive(state)
  // History replay moves the index instead of visiting anew.
  const recordsHistory = stampsVisit && !state.isNavigatingHistory
  return {
    stateTransition: (current) => ({
      activate: true,
      patch: {
        ...(repoId !== null ? { activeRepoId: repoId } : {}),
        ...(stampsVisit
          ? {
              lastVisitedAtByWorktreeId: stampActivationVisits(
                current,
                worktreeId,
                previousActive,
                nextHostId
              )
            }
          : {}),
        ...(recordsHistory ? historyPatch(appendHistoryEntry(current, worktreeId)) : {})
      }
    })
  }
}
