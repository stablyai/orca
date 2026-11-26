import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  resolveGitLabMRMergeState,
  type GitLabMRMergeStateKind
} from '../../../../../../shared/gitlab/gitlab-mr-merge-state'
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

function presentMergeStateKind(
  kind: GitLabMRMergeStateKind,
  t: Translate
): Pick<MergePresentation, 'label' | 'tooltip'> {
  switch (kind) {
    case 'merged':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.fae95ae20d', 'Merged'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.ee482a2bad',
          'This merge request is already merged'
        )
      }
    case 'closed':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.88d044c42f', 'Closed'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.2388413f28',
          'This merge request is closed'
        )
      }
    case 'draft':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.b2715092c6', 'Draft'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.d63bb6f76e',
          'This merge request is still a draft'
        )
      }
    case 'conflicts':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.96b05e374c', 'Conflicts'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.22b7e50621',
          'GitLab reports merge conflicts'
        )
      }
    case 'approval_required':
      return {
        label: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.5105b0e584',
          'Approval required'
        ),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.46dc85711b',
          'GitLab requires approval before this MR can merge'
        )
      }
    case 'changes_requested':
      return {
        label: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.893a999c8c',
          'Changes requested'
        ),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.c65408a99d',
          'A reviewer requested changes on this merge request'
        )
      }
    case 'unresolved_threads':
      return {
        label: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.01ab632a21',
          'Unresolved threads'
        ),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.4191fdfcec',
          'GitLab requires unresolved discussions to be resolved before merge'
        )
      }
    case 'checks_must_pass':
      return {
        label: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.bf628700f6',
          'Checks must pass'
        ),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.37d8637c70',
          'GitLab requires the pipeline to succeed before this MR can merge'
        )
      }
    case 'checks_running':
      return {
        label: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.65c847ad1e',
          'Checks pending'
        ),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.049ea91a82',
          'The pipeline is still running'
        )
      }
    case 'behind':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.382c70faeb', 'Behind'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.2c61100b3a',
          'Update the branch before merging'
        )
      }
    case 'checking':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.195917574e', 'Checking'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.ff6db2db63',
          'GitLab is still computing this merge request status'
        )
      }
    case 'blocked':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.4ecc0d90ee', 'Blocked'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.a0f3de7023',
          'GitLab reports this merge request is blocked'
        )
      }
    case 'unreported_checks_failed':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.49ac4fec10', 'Checks failed'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.804ecf93e8',
          'GitLab has not reported a final merge status'
        )
      }
    case 'unreported':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.195917574e', 'Checking'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.804ecf93e8',
          'GitLab has not reported a final merge status'
        )
      }
    case 'mergeable_checks_failed':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.49ac4fec10', 'Checks failed'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.b41fbc180c',
          'GitLab says this MR can merge, but some pipeline jobs failed'
        )
      }
    case 'mergeable_checks_pending':
      return {
        label: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.65c847ad1e',
          'Checks pending'
        ),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.53c6d3b7e9',
          'GitLab says this MR can merge, but the pipeline is still running'
        )
      }
    case 'mergeable':
      return {
        label: t('auto.components.right.sidebar.gitlab.mr.merge.state.04a3015a12', 'Able to merge'),
        tooltip: t(
          'auto.components.right.sidebar.gitlab.mr.merge.state.a5c049afe4',
          'GitLab says this MR can merge'
        )
      }
  }
}

export function presentGitLabMRMergeState(
  review: GitLabMRMergeStateReview,
  t: Translate = translate
): MergePresentation {
  const decision = resolveGitLabMRMergeState(review)
  return {
    ...presentMergeStateKind(decision.kind, t),
    directMergeAvailable: decision.directMergeAvailable
  }
}
