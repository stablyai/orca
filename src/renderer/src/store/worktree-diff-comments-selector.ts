import type { DiffComment } from '../../../shared/types'
import type { AppState } from './types'
import { getIndexedWorktreeMap } from './worktree-repo-index'

export function selectWorktreeDiffComments(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string | null | undefined
): DiffComment[] | undefined {
  if (!worktreeId) {
    return undefined
  }
  // Why: mounted Monaco and diff surfaces rerun this selector on every store
  // write, so share the immutable-snapshot index instead of rescanning all worktrees.
  return getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)?.diffComments
}
