import type { HostedReviewCreationBlockedReason } from '../../../../shared/hosted-review'

type PRRefreshStatus = 'queued' | 'in-flight' | 'paused' | 'error' | 'skipped' | undefined

type ChecksPanelEmptyStateInput = {
  operationLabel: string | null
  prRefreshStatus: PRRefreshStatus
  hostedReviewBlockedReason: HostedReviewCreationBlockedReason | undefined
  hasUpstream: boolean | undefined
  reviewLabel?: 'pull request' | 'merge request'
  reviewShortLabel?: 'PR' | 'MR'
}

type ChecksPanelEmptyStateCopy = {
  title: string
  description: string
}

export function getChecksPanelEmptyStateCopy(
  input: ChecksPanelEmptyStateInput
): ChecksPanelEmptyStateCopy {
  const reviewLabel = input.reviewLabel ?? 'pull request'
  const reviewShortLabel = input.reviewShortLabel ?? 'PR'
  if (input.operationLabel) {
    return {
      title: `${input.operationLabel} in progress`,
      description: `${reviewShortLabel} checks will be available after the operation completes`
    }
  }

  const blockedReason = input.hostedReviewBlockedReason
  if (
    shouldShowChecksPanelPublishBranchAction({
      hostedReviewBlockedReason: blockedReason,
      hasUpstream: input.hasUpstream
    })
  ) {
    // Why: a local-only branch cannot have GitHub PR status yet; surfacing a
    // refresh error here makes a normal pre-publish state look broken.
    return {
      title: 'Branch not published',
      description: `Publish this branch before creating a ${reviewLabel}.`
    }
  }

  if (blockedReason === 'needs_push') {
    return {
      title: 'Branch has unpushed commits',
      description: `Push your branch before creating a ${reviewLabel}.`
    }
  }

  switch (input.prRefreshStatus) {
    case 'error':
      return {
        title: 'Could not refresh pull request',
        description: 'GitHub status could not be refreshed. Existing cached data was preserved.'
      }
    case 'queued':
      return {
        title: 'Checking for pull request',
        description: 'Waiting to refresh GitHub status for this branch'
      }
    case 'in-flight':
      return {
        title: 'Checking for pull request',
        description: 'Refreshing GitHub status for this branch'
      }
    case 'paused':
      return {
        title: 'No pull request found',
        description: 'GitHub refresh is paused by the current rate-limit budget'
      }
    case 'skipped':
    case undefined:
      return {
        title: `No ${reviewLabel} found`,
        description: `Create a ${reviewLabel} to start checks and review.`
      }
  }
}

export function shouldShowChecksPanelPublishBranchAction(input: {
  hostedReviewBlockedReason: HostedReviewCreationBlockedReason | undefined
  hasUpstream: boolean | undefined
}): boolean {
  const blockedReason = input.hostedReviewBlockedReason
  return input.hasUpstream === false || blockedReason === 'no_upstream'
}
