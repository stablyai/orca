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

/** Decide copy/actions/composer together so uncertainty never reads as no review; see docs/design/pr-panel-refresh-guidance.md. */
export function getChecksPanelReviewState(
  input: ChecksPanelReviewStateInput
): ChecksPanelReviewState {
  const { reviewLabel, reviewShortLabel, providerName } = input

  // Active operations outrank refresh copy.
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

  // Keep positive-review lookups updating without hiding stronger safety guidance.
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

  // Safety blockers own their guidance; existing_review always blocks create.
  if (blockedReason && ELIGIBILITY_SAFETY_BLOCKERS.has(blockedReason)) {
    return safetyBlockerState(input, blockedReason)
  }

  // Known but unrenderable review evidence must block create actions.
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

  if (isBranchBlocker(blockedReason)) {
    return branchBlockerState(
      input,
      blockedReason as NonNullable<HostedReviewCreationBlockedReason>
    )
  }
  // Ready status without upstream means publish; undefined remains unknown.
  if (input.gitStatusPhase === 'ready' && input.hasUpstream === false && input.hasCurrentBranch) {
    return branchBlockerState(input, 'no_upstream')
  }

  // Keep the composer hidden until hard refresh errors clear.
  if (isHardRefreshError(input.refresh)) {
    return hardRefreshErrorState(input)
  }

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

  if (isTransientRefreshFailure(input.refresh)) {
    const mode = confirmedComposerMode(input)
    return transientRefreshState(input, mode, workflowActionForComposer(mode))
  }

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
