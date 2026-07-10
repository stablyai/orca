import type { CreateHostedReviewResult } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'

export type { LocalizedHostedReviewCopy as CreatePullRequestReviewCopy } from '@/i18n/hosted-review-localized-copy'

export { localizedHostedReviewCopy as reviewCopy } from '@/i18n/hosted-review-localized-copy'

export function formatCreateError(
  result: CreateHostedReviewResult,
  pushed: boolean,
  shortLabel: string
): string {
  if (result.ok) {
    return ''
  }
  if (pushed) {
    const prefix = new RegExp(`^Create ${shortLabel} failed:\\s*`, 'i')
    return translate(
      'auto.components.right.sidebar.create.pull.request.review.copy.a1f8c3d2e4',
      'Push succeeded, but {{value0}} creation failed: {{value1}}',
      {
        value0: shortLabel,
        value1: result.error.replace(prefix, '')
      }
    )
  }
  return result.error
}
