import { INTEGRATION_PROVIDER_NAMES } from '../../../shared/integration-provider-names'
import type { HostedReviewProvider } from '../../../shared/hosted-review'
import {
  resolveHostedReviewCreationProvider,
  type HostedReviewCreationProvider
} from '../../../shared/hosted-review-creation-providers'
import { translate } from '@/i18n/i18n'

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
  provider: SupportedHostedReviewCopyProvider
): LocalizedHostedReviewCopy {
  if (provider === 'gitlab') {
    return {
      shortLabel: translate('auto.i18n.hostedReview.copy.c4e8f1a2b9', 'MR'),
      reviewLabel: translate('auto.i18n.hostedReview.copy.b3d7e0f1a8', 'merge request'),
      titleLabel: translate('auto.i18n.hostedReview.copy.a2c6d9e0f7', 'Merge Request'),
      providerName: INTEGRATION_PROVIDER_NAMES.gitlab
    }
  }
  if (provider === 'azure-devops') {
    return {
      shortLabel: translate('auto.i18n.hostedReview.copy.f0a4b8c2d1', 'PR'),
      reviewLabel: translate('auto.i18n.hostedReview.copy.e9f3a7b1c0', 'pull request'),
      titleLabel: translate('auto.i18n.hostedReview.copy.d8e2f6a0b9', 'Pull Request'),
      providerName: INTEGRATION_PROVIDER_NAMES['azure-devops']
    }
  }
  if (provider === 'gitea') {
    return {
      shortLabel: translate('auto.i18n.hostedReview.copy.f0a4b8c2d1', 'PR'),
      reviewLabel: translate('auto.i18n.hostedReview.copy.e9f3a7b1c0', 'pull request'),
      titleLabel: translate('auto.i18n.hostedReview.copy.d8e2f6a0b9', 'Pull Request'),
      providerName: INTEGRATION_PROVIDER_NAMES.gitea
    }
  }
  if (provider === 'bitbucket') {
    return {
      shortLabel: translate('auto.i18n.hostedReview.copy.f0a4b8c2d1', 'PR'),
      reviewLabel: translate('auto.i18n.hostedReview.copy.e9f3a7b1c0', 'pull request'),
      titleLabel: translate('auto.i18n.hostedReview.copy.d8e2f6a0b9', 'Pull Request'),
      providerName: INTEGRATION_PROVIDER_NAMES.bitbucket
    }
  }
  return {
    shortLabel: translate('auto.i18n.hostedReview.copy.f0a4b8c2d1', 'PR'),
    reviewLabel: translate('auto.i18n.hostedReview.copy.e9f3a7b1c0', 'pull request'),
    titleLabel: translate('auto.i18n.hostedReview.copy.d8e2f6a0b9', 'Pull Request'),
    providerName: INTEGRATION_PROVIDER_NAMES.github
  }
}
