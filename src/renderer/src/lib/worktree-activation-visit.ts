import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import type { AppState } from '@/store/types'

type PreviousActive = { worktreeId: string | null; hostId: ExecutionHostId | null }
type VisitState = Pick<
  AppState,
  'activeWorktreeId' | 'activeWorkspaceExecutionHostId' | 'markWorktreeVisited'
>

export function readPreviousActive(state: VisitState): PreviousActive {
  return { worktreeId: state.activeWorktreeId, hostId: state.activeWorkspaceExecutionHostId }
}

/** Stamps focus recency for the workspace being opened; `nextHostId` when the caller names one. */
export function markVisited(
  state: VisitState,
  workspaceId: string,
  previous: PreviousActive,
  nextHostId?: ExecutionHostId | null
): void {
  // Switch point: terminals no longer stamp Recent, so leaving a workspace marks it used up to now.
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    state.markWorktreeVisited(workspaceId)
    return
  }
  const visitedAt = Date.now()
  // The same repoId::path on another host is another workspace.
  const left =
    previous.worktreeId !== null &&
    (previous.worktreeId !== workspaceId ||
      (nextHostId !== undefined && previous.hostId !== nextHostId))
  if (left && previous.worktreeId) {
    state.markWorktreeVisited(previous.worktreeId, visitedAt - 1, previous.hostId ?? undefined)
  }
  state.markWorktreeVisited(workspaceId, visitedAt)
}
