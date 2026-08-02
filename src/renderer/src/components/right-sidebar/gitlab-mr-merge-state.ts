import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'

type GitLabMRMergeStateReview = Pick<HostedReviewInfo, 'state' | 'status' | 'mergeable'>

export function presentGitLabMRMergeState(review: GitLabMRMergeStateReview): {
  label: string
  tooltip: string
  directMergeAvailable: boolean
} {
  if (review.state === 'merged') {
    return {
      label: translate('auto.components.right.sidebar.gitlab.mr.merge.state.fae95ae20d', 'Merged'),
      tooltip: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.ee482a2bad',
        'This merge request is already merged'
      ),
      directMergeAvailable: false
    }
  }
  if (review.state === 'closed') {
    return {
      label: translate('auto.components.right.sidebar.gitlab.mr.merge.state.88d044c42f', 'Closed'),
      tooltip: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.2388413f28',
        'This merge request is closed'
      ),
      directMergeAvailable: false
    }
  }
  if (review.state === 'draft') {
    return {
      label: translate('auto.components.right.sidebar.gitlab.mr.merge.state.b2715092c6', 'Draft'),
      tooltip: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.d63bb6f76e',
        'This merge request is still a draft'
      ),
      directMergeAvailable: false
    }
  }
  if (review.mergeable === 'CONFLICTING') {
    return {
      label: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.96b05e374c',
        'Conflicts'
      ),
      tooltip: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.22b7e50621',
        'GitLab reports merge conflicts'
      ),
      directMergeAvailable: false
    }
  }
  if (review.status === 'failure') {
    return {
      label: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.49ac4fec10',
        'Checks failed'
      ),
      tooltip: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.b41fbc180c',
        'GitLab says this MR can merge, but some pipeline jobs failed'
      ),
      directMergeAvailable: true
    }
  }
  if (review.status === 'pending') {
    return {
      label: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.65c847ad1e',
        'Checks pending'
      ),
      tooltip: translate(
        'auto.components.right.sidebar.gitlab.mr.merge.state.53c6d3b7e9',
        'GitLab says this MR can merge, but the pipeline is still running'
      ),
      directMergeAvailable: true
    }
  }
  return {
    label: translate(
      'auto.components.right.sidebar.gitlab.mr.merge.state.04a3015a12',
      'Able to merge'
    ),
    tooltip:
      review.mergeable === 'UNKNOWN'
        ? 'GitLab has not reported a final merge status'
        : 'GitLab says this MR can merge',
    directMergeAvailable: true
  }
}
