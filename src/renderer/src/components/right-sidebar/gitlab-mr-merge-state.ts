import type { HostedReviewInfo } from '../../../../shared/hosted-review'

type GitLabMRMergeStateReview = Pick<HostedReviewInfo, 'state' | 'status' | 'mergeable'>

export function presentGitLabMRMergeState(review: GitLabMRMergeStateReview): {
  label: string
  tooltip: string
  directMergeAvailable: boolean
} {
  if (review.state === 'merged') {
    return {
      label: 'Merged',
      tooltip: 'This merge request is already merged',
      directMergeAvailable: false
    }
  }
  if (review.state === 'closed') {
    return {
      label: 'Closed',
      tooltip: 'This merge request is closed',
      directMergeAvailable: false
    }
  }
  if (review.state === 'draft') {
    return {
      label: 'Draft',
      tooltip: 'This merge request is still a draft',
      directMergeAvailable: false
    }
  }
  if (review.mergeable === 'CONFLICTING') {
    return {
      label: 'Conflicts',
      tooltip: 'GitLab reports merge conflicts',
      directMergeAvailable: false
    }
  }
  if (review.status === 'failure') {
    return {
      label: 'Checks failed',
      tooltip: 'GitLab says this MR can merge, but some pipeline jobs failed',
      directMergeAvailable: true
    }
  }
  if (review.status === 'pending') {
    return {
      label: 'Checks pending',
      tooltip: 'GitLab says this MR can merge, but the pipeline is still running',
      directMergeAvailable: true
    }
  }
  return {
    label: 'Able to merge',
    tooltip:
      review.mergeable === 'UNKNOWN'
        ? 'GitLab has not reported a final merge status'
        : 'GitLab says this MR can merge',
    directMergeAvailable: true
  }
}
