import type { GitConflictOperation } from '../../../../../../shared/git-status-types'

/**
 * True when the conflict prompt is worth handing to an agent. Live unmerged files always qualify;
 * so does a stopped rebase/merge/cherry-pick with none, because deciding continue vs skip is the
 * judgment the prompt asks for. Only a clean tree with no operation has nothing to send.
 */
export function canSendConflictsToAgent(
  unresolvedConflictCount: number,
  conflictOperation: GitConflictOperation
): boolean {
  return unresolvedConflictCount > 0 || conflictOperation !== 'unknown'
}
