import type { HostedReviewCreationEligibility } from './hosted-review'
import type { GitUpstreamStatus } from './git-status-types'
import type { PRState } from './types'

export type SourceControlPrimaryActionKind =
  | 'commit'
  | 'stage'
  | 'push'
  | 'pull'
  | 'sync'
  | 'publish'
  | 'create_pr_intent'
  | 'create_pr'

export type SourceControlRemoteOpKind =
  | 'push'
  | 'force_push'
  | 'pull'
  | 'sync'
  | 'fetch'
  | 'fast_forward'
  | 'publish'
  | 'rebase'

export type SourceControlPrimaryActionTitleIntent =
  | 'commit_in_progress'
  | 'force_push_in_progress'
  | 'action_in_progress'
  | 'remote_operation_in_progress'
  | 'remote_operation_blocks_commit'
  | 'resolve_conflicts_before_commit'
  | 'prepare_review'
  | 'commit_staged_changes'
  | 'enter_commit_message'
  | 'stage_all_changes'
  | 'stage_file_to_commit'
  | 'checkout_branch_before_publish'
  | 'checking_review_status'
  | 'review_already_merged'
  | 'publish_branch'
  | 'push_linked_review'
  | 'linked_review_target_unavailable'
  | 'force_push_with_lease'
  | 'sync_counts'
  | 'pull_count'
  | 'push_count'
  | 'create_review'
  | 'nothing_to_commit_up_to_date'
  | 'checking_review_creation'

export type SourceControlPrimaryActionDecision = {
  kind: SourceControlPrimaryActionKind
  disabled: boolean
  labelIntent: SourceControlPrimaryActionKind | 'force_push'
  titleIntent: SourceControlPrimaryActionTitleIntent
  count?: number
  ahead?: number
  behind?: number
  upstreamName?: string
  requiresForceWithLease?: boolean
}

export type SourceControlPrimaryActionDecisionInputs = {
  stagedCount: number
  hasUnstagedChanges: boolean
  hasStageableChanges: boolean
  hasPartiallyStagedChanges: boolean
  hasMessage: boolean
  hasUnresolvedConflicts: boolean
  isCommitting: boolean
  isRemoteOperationActive: boolean
  upstreamStatus: GitUpstreamStatus | undefined
  prState?: PRState | null
  isPRStateLoading?: boolean
  inFlightRemoteOpKind?: SourceControlRemoteOpKind | null
  hostedReviewCreation?: HostedReviewCreationEligibility | null
  branchCommitsAhead?: number
  hasCurrentBranch?: boolean
  canPushLinkedReviewWithoutUpstream?: boolean
  isPrIntentInFlight?: boolean
  isHostedReviewCreationLoading?: boolean
}
