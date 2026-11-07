import type { PRCheckDetail } from '../../../../../../shared/github/check-types'
import { translate } from '@/i18n/i18n'

export type CheckStatusLike = {
  status: PRCheckDetail['status'] | (string & {}) | null | undefined
  conclusion: PRCheckDetail['conclusion'] | (string & {}) | null | undefined
}

/** Status label for the check details panel; unknown failure states read as "Failed". */
export function getCheckStatusLabel(check: CheckStatusLike): string {
  const conclusion = check.conclusion ?? 'pending'
  switch (conclusion) {
    case 'success':
      return translate('auto.components.editor.CheckRunDetailsPanel.8f2d0f5a91', 'Passed')
    case 'failure':
      return translate('auto.components.editor.CheckRunDetailsPanel.4c8e1b2d73', 'Failed')
    case 'cancelled':
      return translate('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
    case 'timed_out':
      return translate('auto.components.editor.CheckRunDetailsPanel.2f6d8a1c45', 'Timed out')
    case 'action_required':
      return translate(
        'auto.components.editor.CheckRunDetailsPanel.actionRequired',
        'Action required'
      )
    case 'allowed_failure':
      return translate(
        'auto.components.editor.CheckRunDetailsPanel.allowedFailure',
        'Allowed to fail'
      )
    case 'skipped':
      return translate('auto.components.editor.CheckRunDetailsPanel.7b3e9d4f12', 'Skipped')
    case 'neutral':
      return translate('auto.components.editor.CheckRunDetailsPanel.5a1c8e3d67', 'Neutral')
    case 'pending':
      return translate('auto.components.editor.CheckRunDetailsPanel.3d9f2b8e14', 'Pending')
    default:
      return isFailureState(conclusion)
        ? translate('auto.components.editor.CheckRunDetailsPanel.4c8e1b2d73', 'Failed')
        : translate('auto.components.editor.CheckRunDetailsPanel.3d9f2b8e14', 'Pending')
  }
}

/** Whether a check or job state is a failure; allowed GitLab failures are not. */
export function isFailureState(state: string | null | undefined): boolean {
  return (
    state === 'failure' ||
    state === 'failed' ||
    state === 'action_required' ||
    state === 'cancelled' ||
    state === 'stale' ||
    state === 'startup_failure' ||
    state === 'timed_out'
  )
}
