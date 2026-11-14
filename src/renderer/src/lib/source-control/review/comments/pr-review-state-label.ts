import type { PRReviewVerdict } from '../../../../../../shared/github/comments/comment-types'
import type { Translate } from '@/i18n/use-translate'

export function getPRReviewStateLabel(state: PRReviewVerdict, t: Translate): string {
  return state === 'APPROVED'
    ? t('auto.lib.pr.review.state.approved', 'approved')
    : t('auto.lib.pr.review.state.changesRequested', 'requested changes')
}
