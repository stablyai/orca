import type { Row } from '../worktree-list-groups'
import type { ImportedWorktreeCardActionState } from '../imported-worktrees-card-actions'

export function canKeepImportedWorktreesHidden(
  row: Extract<Row, { type: 'imported-worktrees-card' }>,
  actionState: ImportedWorktreeCardActionState | undefined
): boolean {
  return row.placement === 'repo-group' && actionState?.forceVisible !== true
}
