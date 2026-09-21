import { translate } from '@/i18n/i18n'
import { resolveBlockedCreateReviewNoticeMessage } from '../../source-control-create-review-blocked-action'
import {
  resolveCreatePrIntentRemoteStep,
  shouldAttemptCreateHostedReviewForIntent,
  type CreatePrIntentRunToken
} from './create-pr-intent-flow'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import type { CreatePrIntentRunSnapshot } from './create-pr-intent-run-snapshot'
import type { SourceControlCreatePrIntentProbes } from './use-create-pr-intent-probes'
import type { SourceControlCreatePrIntentReview } from './use-create-pr-intent-review'

/**
 * Reads eligibility on the prepared branch, and when it is still blocked, performs the one remote
 * step that would unblock it before re-reading — nothing here merges or rewrites history unasked.
 */
export async function runCreatePrIntentReviewStep({
  createHostedReviewForCreatePrIntent,
  operationTarget,
  readHostedReviewCreationEligibilityForIntent,
  refreshBranchCompareForCreatePrIntent,
  runRemoteAction,
  setCreatePrIntentNoticeForWorktree,
  snapshot,
  token
}: {
  createHostedReviewForCreatePrIntent: SourceControlCreatePrIntentReview['createHostedReviewForCreatePrIntent']
  operationTarget: SourceControlOperationTarget
  readHostedReviewCreationEligibilityForIntent: SourceControlCreatePrIntentProbes['readHostedReviewCreationEligibilityForIntent']
  refreshBranchCompareForCreatePrIntent: SourceControlCreatePrIntentProbes['refreshBranchCompareForCreatePrIntent']
  runRemoteAction: SourceControlRemoteActionRunner['runRemoteAction']
  setCreatePrIntentNoticeForWorktree: SourceControlWorktreeOperationState['setCreatePrIntentNoticeForWorktree']
  snapshot: CreatePrIntentRunSnapshot
  token: CreatePrIntentRunToken
}): Promise<void> {
  const { abortIfStale, refreshIntentSnapshot } = snapshot

  let eligibility = await readHostedReviewCreationEligibilityForIntent({
    token,
    hasUncommittedChanges: snapshot.entries.length > 0,
    upstreamStatus: snapshot.upstreamStatus
  })
  if (abortIfStale()) {
    return
  }
  if (!eligibility) {
    setCreatePrIntentNoticeForWorktree(token.worktreeId, {
      tone: 'destructive',
      message: translate(
        'auto.components.right.sidebar.SourceControl.d7492cafce',
        'Could not refresh Source Control. Retry Create PR.'
      )
    })
    return
  }
  if (shouldAttemptCreateHostedReviewForIntent(eligibility)) {
    await createHostedReviewForCreatePrIntent(token, eligibility)
    if (abortIfStale()) {
      return
    }
    return
  }
  if (eligibility.blockedReason === 'existing_review') {
    setCreatePrIntentNoticeForWorktree(token.worktreeId, null)
    return
  }

  const branchAhead =
    eligibility.blockedReason === 'no_upstream'
      ? await refreshBranchCompareForCreatePrIntent(token)
      : undefined
  if (abortIfStale()) {
    return
  }
  const remoteStep = resolveCreatePrIntentRemoteStep({
    upstreamStatus: snapshot.upstreamStatus,
    hostedReviewCreation: eligibility,
    branchCommitsAhead: branchAhead,
    hasCurrentBranch: Boolean(token.branch)
  })
  if (remoteStep === 'blocked' || remoteStep === 'none') {
    setCreatePrIntentNoticeForWorktree(token.worktreeId, {
      tone: 'muted',
      // Why: a diverged branch is deliberately not auto-prepared (would merge without consent), so keep explicit sync-first guidance.
      message:
        eligibility.blockedReason === 'needs_sync'
          ? translate(
              'auto.components.right.sidebar.SourceControl.createPrIntentNeedsSync',
              'Sync this branch before creating a review.'
            )
          : translate(
              'auto.components.right.sidebar.SourceControl.createPrIntentBranchNotReady',
              'Branch is not ready to create a review yet.'
            )
    })
    return
  }

  setCreatePrIntentNoticeForWorktree(token.worktreeId, {
    tone: 'muted',
    // Why: keep each translate() key a string literal so the localization-catalog verifier can statically detect it.
    message:
      remoteStep === 'publish'
        ? translate(
            'auto.components.right.sidebar.SourceControl.createPrIntentPublishing',
            'Publishing branch…'
          )
        : remoteStep === 'force_push'
          ? translate(
              'auto.components.right.sidebar.SourceControl.createPrIntentForcePushing',
              'Force pushing with lease…'
            )
          : remoteStep === 'fast_forward'
            ? translate(
                'auto.components.right.sidebar.SourceControl.createPrIntentFastForwarding',
                'Updating branch…'
              )
            : translate(
                'auto.components.right.sidebar.SourceControl.createPrIntentPushing',
                'Pushing commits…'
              )
  })
  const remoteResult = await runRemoteAction(remoteStep, {
    target: operationTarget,
    baseRef: token.baseRef
  })
  if (abortIfStale()) {
    return
  }
  // Superseded by a newer remote action — drop quietly, same as target drift.
  if (remoteResult.status === 'superseded') {
    return
  }
  if (remoteResult.status !== 'ok') {
    setCreatePrIntentNoticeForWorktree(token.worktreeId, {
      tone: 'destructive',
      message: translate(
        'auto.components.right.sidebar.SourceControl.createPrIntentRemoteFailed',
        'Could not update the remote branch. Retry Create PR.'
      )
    })
    return
  }
  if (!(await refreshIntentSnapshot())) {
    return
  }
  await refreshBranchCompareForCreatePrIntent(token)
  if (abortIfStale()) {
    return
  }
  eligibility = await readHostedReviewCreationEligibilityForIntent({
    token,
    hasUncommittedChanges: snapshot.entries.length > 0,
    upstreamStatus: snapshot.upstreamStatus
  })
  if (abortIfStale()) {
    return
  }
  if (eligibility && shouldAttemptCreateHostedReviewForIntent(eligibility)) {
    await createHostedReviewForCreatePrIntent(token, eligibility)
    if (abortIfStale()) {
      return
    }
    return
  }
  // Why: prefer the blocked-reason notice (incl. unavailable lookup) over a generic stop.
  const blockedNotice = resolveBlockedCreateReviewNoticeMessage(eligibility)
  setCreatePrIntentNoticeForWorktree(token.worktreeId, {
    tone: blockedNotice ? 'destructive' : 'muted',
    message:
      blockedNotice ??
      translate(
        'auto.components.right.sidebar.SourceControl.995c5e67ec',
        'Review setup needs attention.'
      )
  })
}
