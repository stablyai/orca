import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ChecksPanelEmptyContent } from './empty-content'
import type { ChecksPanelEmptyContentModel } from './empty-content-props'

const noop = (): void => {}

/** Only the fields the no-review branch reads; composer fields stay inert. */
function model(overrides: Partial<ChecksPanelEmptyContentModel>): ChecksPanelEmptyContentModel {
  const base = {
    activeReview: null,
    activeWorktree: { id: 'wt-1', head: 'h2' },
    activeWorktreeId: 'wt-1',
    branch: 'feature/checks',
    cachedPRNumber: null,
    checksPanelHasHardRefreshError: false,
    checksPanelReviewLookup: 'positive_unresolved',
    checksPanelReviewLookupResult: {
      state: 'positive_unresolved',
      openReviewUrl: 'https://github.com/acme/widgets/pull/7',
      reviewNumber: 7
    },
    confirmedReadiness: { confirmed: false, needsPush: false },
    conflictOperation: 'unknown',
    createComposerOpen: false,
    detachedHeadDisplay: null,
    emptyRefreshing: false,
    gitStatusInputs: { hasUncommittedChanges: false },
    gitStatusProbeErrorContextKey: null,
    hardRefreshError: null,
    hostedReviewCreateCopy: { providerName: 'GitHub' },
    hostedReviewCreateProvider: 'github',
    hostedReviewCreation: { provider: 'github', blockedReason: 'needs_push' },
    isFolder: false,
    isGitHubReviewContext: true,
    isPublishingBranch: false,
    isRemoteOperationActive: false,
    isSyncingBranch: false,
    linkedGitLabMR: null,
    linkedPR: null,
    linkedReviewNumber: null,
    manualRefreshError: null,
    panelContextKey: 'fixture',
    prDetailRecoveryContextKey: null,
    prRefreshState: undefined,
    publishActionHasUncommittedChanges: false,
    publishActionRemoteStatus: { hasUpstream: true, ahead: 2, behind: 0 },
    suppressedGitHubPR: null,
    handleRefresh: () => Promise.resolve({ kind: 'read' as const }),
    setEmptyRefreshing: noop,
    handlePublishBranch: noop,
    handleSyncBranch: noop,
    handleLinkSuppressedPullRequest: noop,
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dev-only fixture; the no-review branch reads only the fields above.
  return base as unknown as ChecksPanelEmptyContentModel
}

/** A branch blocker with known review evidence: push to update the PR, Open PR, never Create. */
export const branchBlockerWithPositiveEvidence = defineFixture({
  width: 320,
  render: () => (
    <div className="bg-sidebar">
      <ChecksPanelEmptyContent model={model({})} />
    </div>
  )
})

export const branchBlockerWithPositiveEvidenceNarrow = defineFixture({
  ...branchBlockerWithPositiveEvidence,
  width: 220
})
