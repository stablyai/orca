import type {
  CreateHostedReviewResult,
  HostedReviewProvider
} from '../../../../shared/hosted-review'

export type CreatePullRequestReviewCopy = {
  shortLabel: 'PR' | 'MR'
  reviewLabel: 'pull request' | 'merge request'
  titleLabel: 'Pull Request' | 'Merge Request'
  providerName: 'GitHub' | 'GitLab'
}

export function reviewCopy(provider: HostedReviewProvider): CreatePullRequestReviewCopy {
  return provider === 'gitlab'
    ? {
        shortLabel: 'MR',
        reviewLabel: 'merge request',
        titleLabel: 'Merge Request',
        providerName: 'GitLab'
      }
    : {
        shortLabel: 'PR',
        reviewLabel: 'pull request',
        titleLabel: 'Pull Request',
        providerName: 'GitHub'
      }
}

export function formatCreateError(
  result: CreateHostedReviewResult,
  pushed: boolean,
  shortLabel: 'PR' | 'MR'
): string {
  if (result.ok) {
    return ''
  }
  if (pushed) {
    const prefix = new RegExp(`^Create ${shortLabel} failed:\\s*`, 'i')
    return `Push succeeded, but ${shortLabel} creation failed: ${result.error.replace(prefix, '')}`
  }
  return result.error
}
