import { isSubmoduleWorktreeRemovalRefusal } from '../../../../shared/worktree/removal'
import type { Worktree } from '../../../../shared/worktree/types'
import { getSubmoduleRemovalRefusalCopy } from './delete-worktree-toast'

/** A delete error as a user reads it: Git's submodule refusal becomes plain copy. */
export function describeWorktreeDeleteError(error: string): string {
  return isSubmoduleWorktreeRemovalRefusal(error) ? getSubmoduleRemovalRefusalCopy() : error
}

/**
 * The delete error to show for a row. A failed delete the host lists wins over renderer state, so
 * every view shows the same error as the card, and a stale local error cannot hide it.
 */
export function getWorktreeDeleteErrorToShow(
  row: Pick<Worktree, 'removalError'> | null | undefined,
  state: { isDeleting: boolean; error: string | null } | undefined
): string | null {
  const error = row?.removalError && !state?.isDeleting ? row.removalError : (state?.error ?? null)
  return error === null ? null : describeWorktreeDeleteError(error)
}
