import type { GitStatusResult } from '../../../../../../shared/git/status/git-status-types'
import type { EditorGitSlice } from '../types/editor-git-slice'

type MarkerMaps = Pick<
  EditorGitSlice,
  'gitRebaseIndexObservationByWorktree' | 'gitOperationRunIdentityByWorktree'
>

/**
 * The per-read markers of a paused operation (rebase index observation, run identity). Returns
 * null when neither changed, so an otherwise identical status read stays a no-op.
 */
export function nextOperationMarkerMaps(
  state: MarkerMaps,
  worktreeId: string,
  status: Pick<GitStatusResult, 'rebaseIndexObservation' | 'operationRunIdentity'>
): MarkerMaps | null {
  const indexObservation = status.rebaseIndexObservation
  const runIdentity = status.operationRunIdentity
  const indexUnchanged =
    state.gitRebaseIndexObservationByWorktree?.[worktreeId] === indexObservation
  const runUnchanged = state.gitOperationRunIdentityByWorktree?.[worktreeId] === runIdentity
  if (indexUnchanged && runUnchanged) {
    return null
  }
  return {
    gitRebaseIndexObservationByWorktree: indexUnchanged
      ? state.gitRebaseIndexObservationByWorktree
      : { ...state.gitRebaseIndexObservationByWorktree, [worktreeId]: indexObservation },
    gitOperationRunIdentityByWorktree: runUnchanged
      ? state.gitOperationRunIdentityByWorktree
      : { ...state.gitOperationRunIdentityByWorktree, [worktreeId]: runIdentity }
  }
}
