import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'

type BitbucketPRMergeStateReview = Pick<HostedReviewInfo, 'state' | 'status' | 'mergeable'>

type MergePresentation = {
  label: string
  tooltip: string
  directMergeAvailable: boolean
}

export function presentBitbucketPRMergeState(
  review: BitbucketPRMergeStateReview
): MergePresentation {
  if (review.state === 'closed') {
    return {
      label: translate('auto.components.right.sidebar.bitbucket.pr.merge.state.closed', 'Declined'),
      tooltip: translate(
        'auto.components.right.sidebar.bitbucket.pr.merge.state.closedTooltip',
        'This pull request is declined'
      ),
      directMergeAvailable: false
    }
  }

  if (review.state === 'merged') {
    return {
      label: translate('auto.components.right.sidebar.bitbucket.pr.merge.state.merged', 'Merged'),
      tooltip: translate(
        'auto.components.right.sidebar.bitbucket.pr.merge.state.mergedTooltip',
        'This pull request is already merged'
      ),
      directMergeAvailable: false
    }
  }

  return {
    label: translate(
      'auto.components.right.sidebar.bitbucket.pr.merge.state.merge',
      'Merge pull request'
    ),
    tooltip: '',
    directMergeAvailable: true
  }
}
