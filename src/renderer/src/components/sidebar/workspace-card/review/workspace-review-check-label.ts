import 'react'

import type { CheckPresentationOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'

import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import '../activity/worktree-card-empty-inputs'

export function checksLabel(status: CheckPresentationOutcome, t: Translate = translate): string {
  switch (status) {
    case 'success':
      return t('auto.components.sidebar.WorktreeCardHelpers.checksPassing', 'Passing')
    case 'failure':
      return t('auto.components.sidebar.WorktreeCardHelpers.checksFailing', 'Failing')
    case 'pending':
      return t('auto.components.sidebar.WorktreeCardHelpers.checksPending', 'Pending')
    case 'cancelled':
      return t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
    case 'neutral':
    case 'none':
    case 'unknown':
      return ''
  }
}
