import type { DropdownActionInputs } from '../../../../../../shared/source-control/dropdown/source-control-dropdown-item-types'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'

const CAN_CREATE_PR: HostedReviewCreationEligibility = {
  provider: 'github',
  review: null,
  canCreate: true,
  blockedReason: null,
  nextAction: null,
  reviewLookupOutcome: 'not_found'
}

const NEEDS_PUSH: HostedReviewCreationEligibility = {
  ...CAN_CREATE_PR,
  canCreate: false,
  blockedReason: 'needs_push',
  nextAction: 'push'
}

// Published branch with an open PR, clean tree, nothing to push or pull, 299 behind origin/main.
const BASE: DropdownActionInputs = {
  stagedCount: 0,
  hasUnstagedChanges: false,
  hasStageableChanges: false,
  hasPartiallyStagedChanges: false,
  hasMessage: false,
  hasUnresolvedConflicts: false,
  isCommitting: false,
  isRemoteOperationActive: false,
  upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 0, behind: 0 },
  prState: 'open',
  hostedReviewCreation: null,
  branchCommitsAhead: 4,
  rebaseBaseRef: 'origin/main',
  rebaseBehindCount: 299
}

const state = (overrides: Partial<DropdownActionInputs>): DropdownActionInputs => ({
  ...BASE,
  ...overrides
})

/** Panel states with the primary each would show, matching the commit-area resolver. */
export const STATES: Record<string, DropdownActionInputs> = {
  behindBase: state({}),
  upToDateWithBase: state({ rebaseBehindCount: 0 }),
  staged: state({ stagedCount: 3, hasMessage: true, primaryActionKind: 'commit' }),
  stagedWithoutMessage: state({ stagedCount: 3 }),
  dirty: state({ hasUnstagedChanges: true, hasStageableChanges: true, primaryActionKind: 'stage' }),
  ahead: state({
    upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 2, behind: 0 },
    primaryActionKind: 'push'
  }),
  behindUpstream: state({
    upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 0, behind: 3 },
    primaryActionKind: 'pull'
  }),
  diverged: state({
    upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 3, behind: 2 },
    primaryActionKind: 'sync'
  }),
  justRebased: state({
    upstreamStatus: {
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 3,
      behind: 2,
      behindCommitsArePatchEquivalent: true
    },
    primaryActionKind: 'push'
  }),
  unpublished: state({
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
    prState: null,
    primaryActionKind: 'publish'
  }),
  pushedNoPr: state({
    prState: null,
    hostedReviewCreation: CAN_CREATE_PR,
    primaryActionKind: 'create_pr'
  }),
  aheadNoPr: state({
    upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 2, behind: 0 },
    prState: null,
    hostedReviewCreation: NEEDS_PUSH,
    primaryActionKind: 'create_pr_intent'
  }),
  mergeConflict: state({ hasUnresolvedConflicts: true, conflictOperation: 'merge' }),
  rebaseConflict: state({
    hasUnresolvedConflicts: true,
    conflictOperation: 'rebase',
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  }),
  busy: state({ isRemoteOperationActive: true, inFlightRemoteOpKind: 'fetch' })
}

/** States where the new menu deliberately differs from main's enabled set (owner-approved). */
export const CHANGED_STATES: Record<string, DropdownActionInputs> = {
  // Tracked edits without rebase.autoStash: Git would refuse, so Rebase is disabled with the reason.
  dirtyWithoutAutoStash: state({
    hasUnstagedChanges: true,
    hasStageableChanges: true,
    rebaseBlockedByDirtyTree: true,
    primaryActionKind: 'stage'
  }),
  // Orca's own rebase integrated the upstream tip: Pull/Sync/FF/Push would undo it or be rejected.
  orcaRebased: state({
    upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 3, behind: 2 },
    rebaseBehindCount: 0,
    suppressPullAfterRebase: true
  }),
  rebaseResolved: state({
    conflictOperation: 'rebase',
    rebaseContinueReady: true,
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  })
}
