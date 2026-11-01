import { isSubmoduleWorktreeRemovalRefusal } from '../../../../shared/worktree/removal'
import type { Worktree } from '../../../../shared/worktree/types'
import { getSubmoduleRemovalRefusalCopy } from './delete-worktree-toast'

export function describeWorktreeDeleteError(error: string): string {
  return isSubmoduleWorktreeRemovalRefusal(error) ? getSubmoduleRemovalRefusalCopy() : error
}

/** Prefer the host-listed delete error so stale renderer state cannot hide it in any view. */
export function getWorktreeDeleteErrorToShow(
  row: Pick<Worktree, 'removalError'> | null | undefined,
  state: { isDeleting: boolean; error: string | null } | undefined
): string | null {
  const error = row?.removalError && !state?.isDeleting ? row.removalError : (state?.error ?? null)
  return error === null ? null : describeWorktreeDeleteError(error)
}
