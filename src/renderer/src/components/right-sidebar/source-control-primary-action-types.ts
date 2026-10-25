import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import type { GitUpstreamStatus } from '../../../../shared/git-status-types'
import type { PRState } from '../../../../shared/github/pull-request-types'
import type {
  SourceControlPrimaryActionKind,
  SourceControlRemoteOpKind
} from '../../../../shared/source-control-primary-action-decision-types'

// Exclude dropdown-only compound kinds so primary dispatch remains exhaustive over actions it can emit.
export type PrimaryActionKind = SourceControlPrimaryActionKind

// Track dropdown remote operations too: Force Push maps to primary Push, while Fetch preserves its natural primary label.
export type RemoteOpKind = SourceControlRemoteOpKind

export type PrimaryAction = {
  kind: PrimaryActionKind
  label: string
  title: string
  disabled: boolean
}

export type PrimaryActionInputs = {
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
  // Mirror the user-triggered in-flight operation instead of showing a stale primary label.
  inFlightRemoteOpKind?: RemoteOpKind | null
  hostedReviewCreation?: HostedReviewCreationEligibility | null
  // Compare counts drive intent/force-push labels; publishing can still push HEAD with zero ahead.
  branchCommitsAhead?: number
  // Detached HEAD may look unpublished but has no branch ref to publish.
  hasCurrentBranch?: boolean
  // Require a persisted/configured review target without upstream so Push cannot fall through to origin publishing.
  canPushLinkedReviewWithoutUpstream?: boolean
  isPrIntentInFlight?: boolean
  // Retain the header anchor while async eligibility loads to avoid flashing it in later.
  isHostedReviewCreationLoading?: boolean
}
