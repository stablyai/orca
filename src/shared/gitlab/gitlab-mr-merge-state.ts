import type { CheckStatus, PRMergeableState } from '../github/pull-requests/pull-request-types'

export type GitLabMRMergeStateInput = {
  state: 'open' | 'closed' | 'merged' | 'draft'
  status: CheckStatus
  mergeable?: PRMergeableState
  /** GitLab's detailed_merge_status, when the read carried it. */
  mergeStateStatus?: string | null
}

export type GitLabMRMergeStateKind =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'conflicts'
  | 'approval_required'
  | 'changes_requested'
  | 'unresolved_threads'
  | 'checks_must_pass'
  | 'checks_running'
  | 'behind'
  | 'checking'
  | 'blocked'
  | 'unreported_checks_failed'
  | 'unreported'
  | 'mergeable_checks_failed'
  | 'mergeable_checks_pending'
  | 'mergeable'

const MERGEABLE_KINDS: ReadonlySet<GitLabMRMergeStateKind> = new Set([
  'mergeable_checks_failed',
  'mergeable_checks_pending',
  'mergeable'
])

/** Map detailed_merge_status to what blocks the merge. */
function resolveUnknownMergeState(
  mergeStateStatus: string | null | undefined,
  checksStatus: GitLabMRMergeStateInput['status']
): GitLabMRMergeStateKind {
  switch ((mergeStateStatus ?? '').toLowerCase()) {
    case 'not_approved':
      return 'approval_required'
    case 'requested_changes':
      return 'changes_requested'
    case 'discussions_not_resolved':
      return 'unresolved_threads'
    case 'ci_must_pass':
      return 'checks_must_pass'
    case 'ci_still_running':
      return 'checks_running'
    case 'need_rebase':
      return 'behind'
    case 'draft_status':
      return 'draft'
    case 'checking':
    case 'unchecked':
    case 'preparing':
      return 'checking'
    case 'blocked_status':
    case 'policies_denied':
    case 'external_status_checks':
    case 'security_policy_violations':
    case 'locked_paths':
    case 'locked_lfs_files':
    case 'jira_association_missing':
    case 'title_regex':
    case 'not_open':
      return 'blocked'
    default:
      // Without a usable merge reason, surface the actionable failed pipeline instead of Checking.
      return checksStatus === 'failure' ? 'unreported_checks_failed' : 'unreported'
  }
}

function resolveMergeStateKind(review: GitLabMRMergeStateInput): GitLabMRMergeStateKind {
  if (review.state === 'merged' || review.state === 'closed' || review.state === 'draft') {
    return review.state
  }
  if (review.mergeable === 'CONFLICTING') {
    return 'conflicts'
  }
  // Only explicit mergeable means ready; UNKNOWN may hide approval, discussion, or CI blockers.
  if (review.mergeable !== 'MERGEABLE') {
    return resolveUnknownMergeState(review.mergeStateStatus, review.status)
  }
  if (review.status === 'failure') {
    return 'mergeable_checks_failed'
  }
  return review.status === 'pending' ? 'mergeable_checks_pending' : 'mergeable'
}

export function resolveGitLabMRMergeState(review: GitLabMRMergeStateInput): {
  kind: GitLabMRMergeStateKind
  directMergeAvailable: boolean
} {
  const kind = resolveMergeStateKind(review)
  return { kind, directMergeAvailable: MERGEABLE_KINDS.has(kind) }
}
