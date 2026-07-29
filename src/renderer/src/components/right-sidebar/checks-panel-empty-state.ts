import type { HostedReviewCreationBlockedReason } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'
import {
  autoRetrySchedule,
  capitalizeReviewLabel,
  confirmedComposerMode,
  ELIGIBILITY_SAFETY_BLOCKERS,
  isBranchBlocker,
  isHardRefreshError,
  isTransientRefreshFailure,
  workflowActionForComposer,
  type ChecksPanelReviewState,
  type ChecksPanelReviewStateInput
} from './checks-panel-review-state-model'
import {
  concurrentLookupDetail,
  hardRefreshErrorState,
  skippedRefreshState,
  transientRefreshState
} from './checks-panel-review-copy'
import { branchBlockerState, safetyBlockerState } from './checks-panel-blocker-copy'

export type {
  ChecksPanelComposerMode,
  ChecksPanelWorkflowAction,
  ChecksPanelRecoveryAction,
  ChecksPanelReviewState,
  ChecksPanelRefreshInput,
  ChecksPanelReviewStateInput
} from './checks-panel-review-state-model'

/**
 * One exhaustive selector for the Checks-panel empty state. Copy, composer mode,
 * workflow action, and recovery actions are decided together — never in separate
 * branches — so an error, pause, skip, or unknown state can never be rendered as
 * "No {reviewLabel} found." See docs/design/pr-panel-refresh-guidance.md.
 */
export function getChecksPanelReviewState(
  input: ChecksPanelReviewStateInput
): ChecksPanelReviewState {
  const { reviewLabel, reviewShortLabel, providerName } = input

  // 0. Operation in progress — never overridden by refresh copy.
  if (input.operationLabel) {
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.empty.state.d77c513c1e',
        '{{value0}} in progress',
        { value0: input.operationLabel }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.empty.state.05e4aec17b',
        '{{value0}} checks will be available after the operation completes',
        { value0: reviewShortLabel }
      ),
      composerMode: 'hidden',
      workflowAction: null,
      recovery: []
    }
  }

  // 1. Renderable review wins over every empty state.
  if (input.reviewLookup === 'found') {
    return {
      renderReview: true,
      title: '',
      description: '',
      composerMode: 'hidden',
      workflowAction: null,
      recovery: []
    }
  }

  const blockedReason = input.eligibilityBlockedReason

  // 1.5 Keep active positive-review lookups self-updating without hiding stronger safety guidance.
  const reviewFetchInFlight =
    input.refresh?.status === 'queued' || input.refresh?.status === 'in-flight'
  const hasPendingReviewEvidence =
    input.reviewLookup === 'positive_unresolved' || blockedReason === 'existing_review'
  const pendingReviewLookupOwnsState =
    blockedReason === undefined || blockedReason === 'existing_review'
  if (reviewFetchInFlight && hasPendingReviewEvidence && pendingReviewLookupOwnsState) {
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.active.title',
        'Checking {{reviewLabel}} status',
        { reviewLabel }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.active.body',
        'Orca is checking {{provider}} for a {{reviewLabel}} on this branch.',
        { reviewLabel, provider: providerName }
      ),
      composerMode: 'hidden',
      workflowAction: null,
      recovery: []
    }
  }

  // 2. Eligibility safety states own their guidance (existing_review is a hard
  //    create block in the positive-evidence family).
  if (blockedReason && ELIGIBILITY_SAFETY_BLOCKERS.has(blockedReason)) {
    return safetyBlockerState(input, blockedReason)
  }

  // 3. Positive unresolved review evidence: never offer Create / Push & Create.
  if (input.reviewLookup === 'positive_unresolved' && !isBranchBlocker(blockedReason)) {
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.positive.title',
        '{{reviewLabelCap}} details unavailable',
        { reviewLabelCap: capitalizeReviewLabel(reviewLabel) }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.positive.body',
        'Orca has saved {{reviewLabel}} information for this branch but could not confirm its current status.',
        { reviewLabel }
      ),
      composerMode: 'hidden',
      workflowAction: null,
      recovery: input.openReviewUrl ? ['open_review', 'retry'] : ['retry'],
      openReviewUrl: input.openReviewUrl
    }
  }

  // 4. Actionable creation blockers (publish / sync / auth / needs_push).
  if (isBranchBlocker(blockedReason)) {
    return branchBlockerState(
      input,
      blockedReason as NonNullable<HostedReviewCreationBlockedReason>
    )
  }
  // A ready Git status reporting no upstream is a publish state even before
  // eligibility resolves. `hasUpstream === undefined` is unknown, never false.
  if (input.gitStatusPhase === 'ready' && input.hasUpstream === false && input.hasCurrentBranch) {
    return branchBlockerState(input, 'no_upstream')
  }

  // 5. Hard refresh error with no blocker above → hide composer until cleared.
  if (isHardRefreshError(input.refresh)) {
    return hardRefreshErrorState(input)
  }

  // 6. Accepted no-review for the exact context.
  if (input.reviewLookup === 'not_found') {
    const detail = isTransientRefreshFailure(input.refresh)
      ? concurrentLookupDetail(input)
      : undefined
    const mode = confirmedComposerMode(input)
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.no_review.title',
        'No {{reviewLabel}} found',
        { reviewLabel }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.no_review.body',
        'Create a {{reviewLabel}} to start checks and review.',
        { reviewLabel }
      ),
      detail,
      composerMode: mode,
      workflowAction: workflowActionForComposer(mode),
      recovery: detail ? ['retry'] : ['refresh'],
      ...(detail ? autoRetrySchedule(input) : {})
    }
  }

  // 7. Transient classified error / rate-limit pause with no accepted result.
  if (isTransientRefreshFailure(input.refresh)) {
    const mode = confirmedComposerMode(input)
    return transientRefreshState(input, mode, workflowActionForComposer(mode))
  }

  // 8. Active refresh (queued / in-flight) with no accepted result.
  if (input.refresh?.status === 'queued' || input.refresh?.status === 'in-flight') {
    const mode = confirmedComposerMode(input)
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.active.title',
        'Checking {{reviewLabel}} status',
        { reviewLabel }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.active.body',
        'Orca is checking {{provider}} for a {{reviewLabel}} on this branch.',
        { reviewLabel, provider: providerName }
      ),
      composerMode: mode,
      workflowAction: workflowActionForComposer(mode),
      recovery: []
    }
  }

  // 9. Git status loading / failure when upstream is still unknown.
  if (input.gitStatusPhase === 'loading' && input.hasUpstream === undefined) {
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.git_loading.title',
        'Checking branch status'
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.git_loading.body',
        'Orca is checking this branch before showing create or publish actions.'
      ),
      composerMode: 'hidden',
      workflowAction: null,
      recovery: []
    }
  }
  if (input.gitStatusPhase === 'error' && input.hasUpstream === undefined) {
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.git_error.title',
        'Could not check branch status'
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.git_error.body',
        "Orca could not confirm this branch's upstream from this environment. Retry before publishing or creating a {{reviewLabel}}.",
        { reviewLabel }
      ),
      composerMode: 'hidden',
      workflowAction: null,
      recovery: ['retry']
    }
  }

  // 10. Skipped structural reasons and missing / unknown — status unavailable.
  if (input.refresh?.status === 'skipped' && input.refresh.skippedReason) {
    if (input.refresh.skippedReason === 'rate-limit') {
      const mode = confirmedComposerMode(input)
      return transientRefreshState(input, mode, workflowActionForComposer(mode))
    }
    const skipped = skippedRefreshState(input, input.refresh.skippedReason)
    if (skipped) {
      return skipped
    }
  }
  return {
    renderReview: false,
    title: translate(
      'auto.components.right.sidebar.checks.panel.review.unknown.title',
      '{{reviewLabelCap}} status unavailable',
      { reviewLabelCap: capitalizeReviewLabel(reviewLabel) }
    ),
    description: translate(
      'auto.components.right.sidebar.checks.panel.review.unknown.body',
      'Orca has not confirmed the {{reviewLabel}} status for this branch. Retry to check again.',
      { reviewLabel }
    ),
    composerMode: 'hidden',
    workflowAction: null,
    recovery: ['retry']
  }
}

/**
 * Separates local-only branch guidance from hosted-review refresh uncertainty.
 */
export function shouldShowChecksPanelPublishBranchAction(input: {
  hostedReviewBlockedReason: HostedReviewCreationBlockedReason | undefined
  hasUpstream: boolean | undefined
  hasCurrentBranch?: boolean
}): boolean {
  if (input.hasCurrentBranch === false) {
    return false
  }
  const blockedReason = input.hostedReviewBlockedReason
  return input.hasUpstream === false || blockedReason === 'no_upstream'
}
