import type { GitHubPRReviewStatus } from '../../../../../../shared/github/pull-requests/pr-reviewer-display'
import type { Translate } from '@/i18n/use-translate'

export function getGitHubPRReviewStatusLabel(status: GitHubPRReviewStatus, t: Translate): string {
  const logins = status.logins.join(', ')
  switch (status.kind) {
    case 'approved':
      return logins
        ? t('auto.hostedReview.reviewStatus.approvedBy', 'Approved by {{logins}}', { logins })
        : t('auto.hostedReview.reviewStatus.approved', 'Approved')
    case 'changesRequested':
      return logins
        ? t(
            'auto.hostedReview.reviewStatus.changesRequestedBy',
            'Changes requested by {{logins}}',
            {
              logins
            }
          )
        : t('auto.hostedReview.reviewStatus.changesRequested', 'Changes requested')
    case 'reviewRequired':
      return t('auto.hostedReview.reviewStatus.reviewRequired', 'Review required')
  }
}
