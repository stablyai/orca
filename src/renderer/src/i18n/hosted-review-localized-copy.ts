import type {
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  resolveHostedReviewCreationProvider,
  type HostedReviewCreationProvider
} from '../../../shared/source-control/hosted-review/hosted-review-creation-providers'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type SupportedHostedReviewCopyProvider = HostedReviewCreationProvider

export type LocalizedHostedReviewCopy = {
  shortLabel: string
  reviewLabel: string
  titleLabel: string
  providerName: string
}

export function resolveSupportedHostedReviewCopyProvider(
  provider: HostedReviewProvider | null | undefined
): SupportedHostedReviewCopyProvider {
  return resolveHostedReviewCreationProvider(provider)
}

export function localizedHostedReviewCopy(
  provider: SupportedHostedReviewCopyProvider,
  t: Translate = translate
): LocalizedHostedReviewCopy {
  if (provider === 'gitlab') {
    return {
      shortLabel: t('auto.i18n.hostedReview.copy.c4e8f1a2b9', 'MR'),
      reviewLabel: t('auto.i18n.hostedReview.copy.b3d7e0f1a8', 'merge request'),
      titleLabel: t('auto.i18n.hostedReview.copy.a2c6d9e0f7', 'Merge Request'),
      providerName: t('auto.i18n.hostedReview.copy.91b5c8d7e6', 'GitLab')
    }
  }
  if (provider === 'azure-devops') {
    return {
      shortLabel: t('auto.i18n.hostedReview.copy.f0a4b8c2d1', 'PR'),
      reviewLabel: t('auto.i18n.hostedReview.copy.e9f3a7b1c0', 'pull request'),
      titleLabel: t('auto.i18n.hostedReview.copy.d8e2f6a0b9', 'Pull Request'),
      providerName: 'Azure DevOps'
    }
  }
  if (provider === 'gitea') {
    return {
      shortLabel: t('auto.i18n.hostedReview.copy.f0a4b8c2d1', 'PR'),
      reviewLabel: t('auto.i18n.hostedReview.copy.e9f3a7b1c0', 'pull request'),
      titleLabel: t('auto.i18n.hostedReview.copy.d8e2f6a0b9', 'Pull Request'),
      providerName: 'Gitea'
    }
  }
  if (provider === 'bitbucket') {
    return {
      shortLabel: t('auto.i18n.hostedReview.copy.f0a4b8c2d1', 'PR'),
      reviewLabel: t('auto.i18n.hostedReview.copy.e9f3a7b1c0', 'pull request'),
      titleLabel: t('auto.i18n.hostedReview.copy.d8e2f6a0b9', 'Pull Request'),
      providerName: 'Bitbucket'
    }
  }
  return {
    shortLabel: t('auto.i18n.hostedReview.copy.f0a4b8c2d1', 'PR'),
    reviewLabel: t('auto.i18n.hostedReview.copy.e9f3a7b1c0', 'pull request'),
    titleLabel: t('auto.i18n.hostedReview.copy.d8e2f6a0b9', 'Pull Request'),
    providerName: t('auto.i18n.hostedReview.copy.c7d1e5f9a8', 'GitHub')
  }
}

/** Names one review the way its host does, e.g. "PR #412" or "MR #7". */
export function hostedReviewNumberLabel(
  review: Pick<HostedReviewInfo, 'provider' | 'number'>,
  t: Translate = translate
): string {
  const { shortLabel } = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(review.provider),
    t
  )
  return `${shortLabel} #${review.number}`
}
