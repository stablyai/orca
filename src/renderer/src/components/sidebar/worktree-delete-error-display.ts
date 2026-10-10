import type { Worktree } from '../../../../shared/worktree/types'
import { classifyWorktreeForceDeleteReason } from '../../../../shared/worktree/removal'
import { getSubmoduleRemovalWarning } from './submodule-removal-warning'

/**
 * The delete error to show for a row. A failed delete the host lists wins over renderer state, so
 * every view shows the same error as the card, and a stale local error cannot hide it.
 */
export function getWorktreeDeleteErrorToShow(
  row: Pick<Worktree, 'removalError'> | null | undefined,
  state: { isDeleting: boolean; error: string | null } | undefined
): string | null {
  const error = row?.removalError && !state?.isDeleting ? row.removalError : (state?.error ?? null)
  // Why: the dialog's force action must carry the same submodule loss warning as the failure toast.
  return error && classifyWorktreeForceDeleteReason(error) === 'submodules'
    ? getSubmoduleRemovalWarning()
    : error
}
