import type { GitConflictKind } from '../../../../shared/types'

export const CONFLICT_KIND_LABELS: Record<GitConflictKind, string> = {
  both_modified: 'Both modified',
  both_added: 'Both added',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them',
  both_deleted: 'Both deleted'
}
