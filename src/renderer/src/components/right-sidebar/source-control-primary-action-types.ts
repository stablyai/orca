import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import type { GitUpstreamStatus, PRState } from '../../../../shared/types'

// Why: the primary button collapses to one-label-per-action. Compound
// kinds ('commit_push', 'commit_sync', 'commit_publish') live in
// DropdownActionKind only — never on the primary — so they are not part
// of this union. Narrowing the type here is load-bearing: it lets
// `handlePrimaryClick` switch exhaustively over only the kinds the
// primary can actually emit, and it kills the compound-commit branch in
// the isRemoteOperationActive tooltip below at compile time.
export type PrimaryActionKind =
  | 'commit'
  | 'stage'
  | 'push'
  | 'pull'
  | 'sync'
  | 'publish'
  | 'create_pr_intent'
  | 'create_pr'

// Why: the in-flight remote op tracker stores which action the user actually
// triggered, so the primary button can mirror that label/spinner instead of
// claiming a stale or unrelated operation is running. Dropdown-only remote
// kinds are included because they participate in the busy flag, but they are
// intentionally NOT in PrimaryActionKind — when Fetch is in flight the primary
// keeps its natural label, while Force Push maps back to the push icon/slot.
export type RemoteOpKind =
  | 'push'
  | 'force_push'
  | 'pull'
  | 'sync'
  | 'fetch'
  | 'fast_forward'
  | 'publish'
  | 'rebase'

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
  // Why: which remote op is currently running, when one is. null when no
  // remote op is in flight. Used by the in-flight branch below to mirror
  // the user-triggered action on the primary button instead of leaving a
  // stale label that no longer matches what the slice is doing.
  inFlightRemoteOpKind?: RemoteOpKind | null
  hostedReviewCreation?: HostedReviewCreationEligibility | null
  // Why: branch-compare counts feed Create Review intent eligibility and
  // force-push labels; publishing itself can push the current HEAD even at 0.
  branchCommitsAhead?: number
  // Why: detached HEAD can look like an unpublished branch from upstream
  // status alone, but it has no branch ref that Publish Branch can push.
  hasCurrentBranch?: boolean
  // Why: linked review branches without upstream counts are pushable only when
  // Orca has a persisted or Git-configured target. Otherwise Push could fall
  // through to the default publish-to-origin behavior.
  canPushLinkedReviewWithoutUpstream?: boolean
  isPrIntentInFlight?: boolean
  // Why: eligibility is fetched asynchronously; keep the header anchor visible
  // while the request is in flight instead of flashing it in after ~1s.
  isHostedReviewCreationLoading?: boolean
}

export const PRIMARY_LABEL_BY_KIND: Record<Exclude<PrimaryActionKind, 'commit'>, string> = {
  stage: 'Stage All',
  push: 'Push',
  pull: 'Pull',
  sync: 'Sync',
  publish: 'Publish Branch',
  create_pr_intent: 'Create PR',
  create_pr: 'Create PR'
}
