import { translate } from '@/i18n/i18n'

export function getHostedReviewStateChangeCopy(
  isClosing: boolean,
  reviewRef: string,
  reviewLabel: string
): { title: string; description: string; confirmLabel: string; failure: string } {
  if (isClosing) {
    return {
      title: translate(
        'auto.components.right.sidebar.HostedReviewActions.closeReviewConfirmTitle',
        'Close {{review}}?',
        { review: reviewRef }
      ),
      description: translate(
        'auto.components.right.sidebar.HostedReviewActions.a3d572a4de',
        'This will close the {{value0}}.',
        { value0: reviewLabel }
      ),
      confirmLabel: translate(
        'auto.components.right.sidebar.HostedReviewActions.closeConfirm',
        'Close'
      ),
      failure: translate(
        'auto.components.right.sidebar.HostedReviewActions.closeReviewFailed',
        'Failed to close {{review}}',
        { review: reviewLabel }
      )
    }
  }
  return {
    title: translate(
      'auto.components.right.sidebar.HostedReviewActions.reopenReviewConfirmTitle',
      'Reopen {{review}}?',
      { review: reviewRef }
    ),
    description: translate(
      'auto.components.right.sidebar.HostedReviewActions.78f5ff294c',
      'This will reopen the {{value0}}.',
      { value0: reviewLabel }
    ),
    confirmLabel: translate(
      'auto.components.right.sidebar.HostedReviewActions.reopenConfirm',
      'Reopen'
    ),
    failure: translate(
      'auto.components.right.sidebar.HostedReviewActions.reopenReviewFailed',
      'Failed to reopen {{review}}',
      { review: reviewLabel }
    )
  }
}
