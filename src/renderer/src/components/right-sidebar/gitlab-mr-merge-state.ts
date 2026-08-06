import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'

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
function presentUnknownMergeState(mergeStateStatus: string | null | undefined): MergePresentation {
  const status = (mergeStateStatus ?? '').toLowerCase()
  switch (status) {
    case 'not_approved':
      return blockedPresentation(
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.approval.required',
          'Approval required'
        ),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.approval.required.tip',
          'GitLab requires approval before this MR can merge'
        )
      )
    case 'requested_changes':
      return blockedPresentation(
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.changes.requested',
          'Changes requested'
        ),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.changes.requested.tip',
          'A reviewer requested changes on this merge request'
        )
      )
    case 'discussions_not_resolved':
      return blockedPresentation(
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.unresolved',
          'Unresolved threads'
        ),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.unresolved.tip',
          'GitLab requires unresolved discussions to be resolved before merge'
        )
      )
    case 'ci_must_pass':
      return blockedPresentation(
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.checks.must.pass',
          'Checks must pass'
        ),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.checks.must.pass.tip',
          'GitLab requires the pipeline to succeed before this MR can merge'
        )
      )
    case 'ci_still_running':
      return blockedPresentation(
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.65c847ad1e',
          'Checks pending'
        ),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.pipeline.running.tip',
          'The pipeline is still running'
        )
      )
    case 'need_rebase':
      return blockedPresentation(
        translate('auto.components.right.sidebar.gitlab.mr.merge.state.behind', 'Behind'),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.behind.tip',
          'Update the branch before merging'
        )
      )
    case 'draft_status':
      return blockedPresentation(
        translate('auto.components.right.sidebar.gitlab.mr.merge.state.b2715092c6', 'Draft'),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.d63bb6f76e',
          'This merge request is still a draft'
        )
      )
    case 'checking':
    case 'unchecked':
    case 'preparing':
      return blockedPresentation(
        translate('auto.components.right.sidebar.gitlab.mr.merge.state.checking', 'Checking'),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.checking.tip',
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
        translate('auto.components.right.sidebar.gitlab.mr.merge.state.blocked', 'Blocked'),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.blocked.tip',
          'GitLab reports this merge request is blocked'
        )
      )
    default:
      return blockedPresentation(
        translate('auto.components.right.sidebar.gitlab.mr.merge.state.checking', 'Checking'),
        translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.unknown.tip',
          'GitLab has not reported a final merge status'
        )
      )
  }
}

export function presentGitLabMRMergeState(review: GitLabMRMergeStateReview): MergePresentation {
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
  // Why: only GitLab's explicit `mergeable` projects to MERGEABLE. UNKNOWN used to fall through
  // to "Able to merge", so not_approved / discussions_not_resolved / ci_must_pass looked ready.
  if (review.mergeable !== 'MERGEABLE') {
    return presentUnknownMergeState(review.mergeStateStatus)
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
    tooltip: 'GitLab says this MR can merge',
    directMergeAvailable: true
  }
}
