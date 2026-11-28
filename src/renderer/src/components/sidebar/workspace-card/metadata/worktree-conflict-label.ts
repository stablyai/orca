import 'react'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'

import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import '../activity/worktree-card-empty-inputs'

export function conflictOperationLabel(
  operation: GitConflictOperation,
  t: Translate = translate
): string {
  switch (operation) {
    case 'merge':
      return t('auto.components.sidebar.WorktreeCardHelpers.conflictMerging', 'Merging')
    case 'rebase':
      return t('auto.components.sidebar.WorktreeCardHelpers.conflictRebasing', 'Rebasing')
    case 'cherry-pick':
      return t(
        'auto.components.sidebar.WorktreeCardHelpers.conflictCherryPicking',
        'Cherry-picking'
      )
    case 'revert':
      return t('gitGraph.reverting', 'Reverting')
    case 'unknown':
      return ''
  }
}
