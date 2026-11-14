import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

type GitLabMRMergeStateReview = Pick<
  HostedReviewInfo,
  'state' | 'status' | 'mergeable' | 'mergeStateStatus'
>

type MergePresentation = {
  label: string
  tooltip: string
  directMergeAvailable: boolean
}

function blockedPresentation(label: string, tooltip: string): MergePresentation {
  return { label, tooltip, directMergeAvailable: false }
}

/** Map GitLab detailed_merge_status (stored on mergeStateStatus) to a blocked/checking label. */
function presentUnknownMergeState(
  mergeStateStatus: string | null | undefined,
  checksStatus: GitLabMRMergeStateReview['status'],
  t: Translate = translate
): MergePresentation {
  const status = (mergeStateStatus ?? '').toLowerCase()
  switch (status) {
    case 'not_approved':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.5105b0e584', 'Approval required'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.46dc85711b',
          'GitLab requires approval before this MR can merge'
        )
      )
    case 'requested_changes':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.893a999c8c', 'Changes requested'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.c65408a99d',
          'A reviewer requested changes on this merge request'
        )
      )
    case 'discussions_not_resolved':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.01ab632a21', 'Unresolved threads'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.4191fdfcec',
          'GitLab requires unresolved discussions to be resolved before merge'
        )
      )
    case 'ci_must_pass':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.bf628700f6', 'Checks must pass'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.37d8637c70',
          'GitLab requires the pipeline to succeed before this MR can merge'
        )
      )
    case 'ci_still_running':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.65c847ad1e', 'Checks pending'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.049ea91a82',
          'The pipeline is still running'
        )
      )
    case 'need_rebase':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.382c70faeb', 'Behind'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.2c61100b3a',
          'Update the branch before merging'
        )
      )
    case 'draft_status':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.b2715092c6', 'Draft'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.d63bb6f76e',
          'This merge request is still a draft'
        )
      )
    case 'checking':
    case 'unchecked':
    case 'preparing':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.195917574e', 'Checking'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.ff6db2db63',
          'GitLab is still computing this merge request status'
        )
      )
    case 'blocked_status':
    case 'policies_denied':
    case 'external_status_checks':
    case 'security_policy_violations':
    case 'locked_paths':
    case 'locked_lfs_files':
    case 'jira_association_missing':
    case 'title_regex':
    case 'not_open':
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.4ecc0d90ee', 'Blocked'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.a0f3de7023',
          'GitLab reports this merge request is blocked'
        )
      )
    default:
      // Without a usable merge reason, surface the actionable failed pipeline instead of Checking.
      if (checksStatus === 'failure') {
        return blockedPresentation(
          t('auto.components.right.sidebar.gitlab.mr.merge.state.49ac4fec10', 'Checks failed'),
          t(
            'auto.components.right.sidebar.gitlab.mr.merge.state.804ecf93e8',
            'GitLab has not reported a final merge status'
          )
        )
      }
      return blockedPresentation(
        t('auto.components.right.sidebar.gitlab.mr.merge.state.195917574e', 'Checking'),
        t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.804ecf93e8',
          'GitLab has not reported a final merge status'
        )
      )
  }
}

export function presentGitLabMRMergeState(
  review: GitLabMRMergeStateReview,
  t: Translate = translate
): MergePresentation {
  if (review.state === 'merged') {
    return {
      label: t('auto.components.right.sidebar.gitlab.mr.merge.state.fae95ae20d', 'Merged'),
      tooltip: t(
        'auto.components.right.sidebar.gitlab.mr.merge.state.ee482a2bad',
        'This merge request is already merged'
      ),
      directMergeAvailable: false
    }
  }
  if (review.state === 'closed') {
    return {
      label: t('auto.components.right.sidebar.gitlab.mr.merge.state.88d044c42f', 'Closed'),
      tooltip: t(
        'auto.components.right.sidebar.gitlab.mr.merge.state.2388413f28',
        'This merge request is closed'
      ),
      directMergeAvailable: false
    }
  }
  if (review.state === 'draft') {
    return {
      label: t('auto.components.right.sidebar.gitlab.mr.merge.state.b2715092c6', 'Draft'),
      tooltip: t(
        'auto.components.right.sidebar.gitlab.mr.merge.state.d63bb6f76e',
        'This merge request is still a draft'
      ),
      directMergeAvailable: false
    }
  }
  if (review.mergeable === 'CONFLICTING') {
    return {
      label: t('auto.components.right.sidebar.gitlab.mr.merge.state.96b05e374c', 'Conflicts'),
      tooltip: t(
        'auto.components.right.sidebar.gitlab.mr.merge.state.22b7e50621',
        'GitLab reports merge conflicts'
      ),
      directMergeAvailable: false
    }
  }
  // Only explicit mergeable means ready; UNKNOWN may hide approval, discussion, or CI blockers.
  if (review.mergeable !== 'MERGEABLE') {
    return presentUnknownMergeState(review.mergeStateStatus, review.status, t)
  }
  if (review.status === 'failure') {
    return {
      label: t('auto.components.right.sidebar.gitlab.mr.merge.state.49ac4fec10', 'Checks failed'),
      tooltip: t(
        'auto.components.right.sidebar.gitlab.mr.merge.state.b41fbc180c',
        'GitLab says this MR can merge, but some pipeline jobs failed'
      ),
      directMergeAvailable: true
    }
  }
  if (review.status === 'pending') {
    return {
      label: t('auto.components.right.sidebar.gitlab.mr.merge.state.65c847ad1e', 'Checks pending'),
      tooltip: t(
        'auto.components.right.sidebar.gitlab.mr.merge.state.53c6d3b7e9',
        'GitLab says this MR can merge, but the pipeline is still running'
      ),
      directMergeAvailable: true
    }
  }
  return {
    label: t('auto.components.right.sidebar.gitlab.mr.merge.state.04a3015a12', 'Able to merge'),
    tooltip: t(
      'auto.components.right.sidebar.gitlab.mr.merge.state.a5c049afe4',
      'GitLab says this MR can merge'
    ),
    directMergeAvailable: true
  }
}
