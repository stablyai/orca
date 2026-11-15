import { isSubmoduleWorktreeRemovalRefusal } from '../../../../../../shared/worktree/removal/removal'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getSubmoduleRemovalRefusalCopy } from './delete-worktree-toast'
import type { Translate } from '../../../../i18n/use-translate'

export function describeWorktreeDeleteError(error: string, t?: Translate): string {
  return isSubmoduleWorktreeRemovalRefusal(error) ? getSubmoduleRemovalRefusalCopy(t) : error
}

/** Prefer the host-listed delete error so stale renderer state cannot hide it in any view. */
export function getWorktreeDeleteErrorToShow(
  row: Pick<Worktree, 'removalError'> | null | undefined,
  state: { isDeleting: boolean; error: string | null } | undefined,
  t?: Translate
): string | null {
  const error = row?.removalError && !state?.isDeleting ? row.removalError : (state?.error ?? null)
  return error === null ? null : describeWorktreeDeleteError(error, t)
}
