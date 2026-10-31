import type {
  CreateHostedReviewResult,
  CreateStackedHostedReviewResult,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import {
  localizedCreateFailure,
  localizedCreateFailureDetail
} from './hosted-review-create-failure-copy'

export type { LocalizedHostedReviewCopy as CreatePullRequestReviewCopy } from '@/i18n/hosted-review-localized-copy'

export { localizedHostedReviewCopy as reviewCopy } from '@/i18n/hosted-review-localized-copy'

export function formatCreateError(
  result: CreateHostedReviewResult | CreateStackedHostedReviewResult,
  pushed: boolean,
  provider: HostedReviewProvider
): string {
  if (result.ok) {
    return ''
  }
  if (!pushed) {
    return localizedCreateFailure(result, provider)
  }
  return translate(
    'auto.components.right.sidebar.create.pull.request.review.copy.a1f8c3d2e4',
    'Push succeeded, but {{value0}} creation failed: {{value1}}',
    {
      value0: localizedHostedReviewCopy(resolveSupportedHostedReviewCopyProvider(provider))
        .shortLabel,
      value1: localizedCreateFailureDetail(result, provider)
    }
  )
}
