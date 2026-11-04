import 'react'

import type { CheckPresentationOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'

import { translate } from '@/i18n/i18n'
import '../activity/worktree-card-empty-inputs'

export function checksLabel(status: CheckPresentationOutcome): string {
  switch (status) {
    case 'success':
      return translate('auto.components.sidebar.WorktreeCardHelpers.checksPassing', 'Passing')
    case 'failure':
      return translate('auto.components.sidebar.WorktreeCardHelpers.checksFailing', 'Failing')
    case 'pending':
      return translate('auto.components.sidebar.WorktreeCardHelpers.checksPending', 'Pending')
    case 'cancelled':
      return translate('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
    case 'neutral':
    case 'none':
    case 'unknown':
      return ''
  }
}
