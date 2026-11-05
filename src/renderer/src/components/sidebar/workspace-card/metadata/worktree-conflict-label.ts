import 'react'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'

import { translate } from '@/i18n/i18n'
import '../activity/worktree-card-empty-inputs'

export function conflictOperationLabel(operation: GitConflictOperation): string {
  switch (operation) {
    case 'merge':
      return translate('auto.components.sidebar.WorktreeCardHelpers.conflictMerging', 'Merging')
    case 'rebase':
      return translate('auto.components.sidebar.WorktreeCardHelpers.conflictRebasing', 'Rebasing')
    case 'cherry-pick':
      return translate(
        'auto.components.sidebar.WorktreeCardHelpers.conflictCherryPicking',
        'Cherry-picking'
      )
    case 'unknown':
      return ''
  }
}
