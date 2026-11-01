import type { CheckStatus, ProviderCheckSummary } from './pull-request-types'
import {
  canShowGitHubPRAutoMergeControl,
  type GitHubPRAutoMergeAvailabilityInput
} from './pull-request-auto-merge-availability'

export type GitHubPRMergeStateInput = GitHubPRAutoMergeAvailabilityInput & {
  checksStatus?: CheckStatus
  checksSummary?: ProviderCheckSummary
}

export type GitHubPRMergeStateKind =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'review_required'
  | 'changes_requested'
  | 'conflicts'
  | 'merge_queue'
  | 'merge_queue_auto_merge_on'
  | 'merge_status_unavailable'
  | 'behind'
  | 'blocked'
  | 'mergeable_checks_failed'
  | 'mergeable_checks_pending'
  | 'mergeable_checks_passed'
  | 'mergeable'
  | 'checks_passed'
  | 'checking'

export type GitHubPRAutoMergeActionIntent =
  | 'disable_auto_merge'
  | 'merge_when_ready'
  | 'enable_auto_merge'

export type GitHubPRMergeStateDecision = {
  kind: GitHubPRMergeStateKind
  directMergeAvailable: boolean
  autoMergeAction: GitHubPRAutoMergeActionIntent | null
}

function checksState(item: GitHubPRMergeStateInput): CheckStatus | 'none' | undefined {
  if (item.checksSummary) {
    return item.checksSummary.state
  }
  return item.checksStatus
}

function hasFullMergeMetadata(item: GitHubPRMergeStateInput): boolean {
  return item.mergeable !== undefined || item.mergeStateStatus !== undefined
}

function resolveAutoMergeAction(
  item: GitHubPRMergeStateInput
): GitHubPRAutoMergeActionIntent | null {
  if (!canShowGitHubPRAutoMergeControl(item)) {
    return null
  }
  if (item.autoMergeEnabled === true) {
    return 'disable_auto_merge'
  }
  if (item.mergeQueueRequired === true) {
    return 'merge_when_ready'
  }
  return 'enable_auto_merge'
}

function resolveMergeStateKind(item: GitHubPRMergeStateInput): GitHubPRMergeStateKind {
  if (item.state === 'merged') {
    return 'merged'
  }
  if (item.state === 'closed') {
    return 'closed'
  }
  if (item.state === 'draft') {
    return 'draft'
  }
  if (item.reviewDecision === 'REVIEW_REQUIRED') {
    return 'review_required'
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return 'changes_requested'
  }
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'DIRTY') {
    return 'conflicts'
  }
  if (item.mergeQueueRequired === true) {
    return item.autoMergeEnabled ? 'merge_queue_auto_merge_on' : 'merge_queue'
  }
  const checkState = checksState(item)
  if (!hasFullMergeMetadata(item)) {
    // Missing metadata can coexist with green checks; main-process preflight remains the merge authority.
    return checkState === 'success' ? 'checks_passed' : 'merge_status_unavailable'
  }
  if (item.mergeStateStatus === 'BEHIND') {
    return 'behind'
  }
  if (item.mergeStateStatus === 'BLOCKED') {
    return 'blocked'
  }
  if (
    item.mergeable === 'MERGEABLE' ||
    item.mergeStateStatus === 'CLEAN' ||
    item.mergeStateStatus === 'UNSTABLE' ||
    item.mergeStateStatus === 'HAS_HOOKS'
  ) {
    if (checkState === 'failure') {
      return 'mergeable_checks_failed'
    }
    if (checkState === 'pending') {
      return 'mergeable_checks_pending'
    }
    return checkState === 'success' ? 'mergeable_checks_passed' : 'mergeable'
  }
  // Main-process preflight rechecks blockers when GitHub mergeability is still intermediate despite green checks.
  return checkState === 'success' ? 'checks_passed' : 'checking'
}

const DIRECT_MERGE_KINDS: ReadonlySet<GitHubPRMergeStateKind> = new Set([
  'mergeable_checks_failed',
  'mergeable_checks_pending',
  'mergeable_checks_passed',
  'mergeable',
  'checks_passed'
])

export function resolveGitHubPRMergeState(
  item: GitHubPRMergeStateInput
): GitHubPRMergeStateDecision {
  const kind = resolveMergeStateKind(item)
  return {
    kind,
    directMergeAvailable: DIRECT_MERGE_KINDS.has(kind),
    autoMergeAction: resolveAutoMergeAction(item)
  }
}
