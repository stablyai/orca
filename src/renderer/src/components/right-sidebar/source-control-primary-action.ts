// Why: split from the combined primary+dropdown module because the primary and dropdown are independent derivations with different priority ladders; together they exceed the max-lines budget and tangle unrelated concerns.

import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { type PrimaryAction, type PrimaryActionInputs } from './source-control-primary-action-types'
import { resolvePrimaryActionDuringRemoteOp } from './source-control-primary-action-in-flight'
import {
  describeForcePushWithLease,
  describePullCount,
  describePushCount,
  describeSyncCounts
} from './source-control-primary-action-titles'
import { resolveLinkedReviewPrimaryAction } from './source-control-linked-review-primary-action'
import {
  resolveCreatePrIntentInFlightPrimaryAction,
  resolveCreatePrIntentPrimaryAction
} from './source-control-primary-create-pr-intent-action'
import { resolveUnpublishedPrimaryAction } from './source-control-primary-unpublished-action'

export type {
  PrimaryActionKind,
  RemoteOpKind,
  PrimaryAction,
  PrimaryActionInputs
} from './source-control-primary-action-types'

// Why: this module owns the pure state-machine logic for the Source Control
// primary action (split button). Keeping the logic outside the React component
// makes it straightforward to unit-test each row of the priority table without
// spinning up a renderer.

/**
 * Resolve the primary split-button action.
 *
 * Priority order mirrors the design-doc state machine:
 *   1. In-flight commit locks the primary to a disabled "Commit".
 *   2. In-flight remote operation keeps the current label but disables it.
 *   3. Unresolved conflicts block the commit path entirely.
 *   4. Create PR intent can own the primary; manual prerequisites are
 *      exposed as a visible sibling action by CommitArea.
 *   5. Has partially staged files → "Stage All" to avoid hook-time partial
 *      stash conflicts.
 *   6. Has staged files + message → plain "Commit" (compound flows live in
 *      the dropdown; after the commit lands, the clean-tree rung rotates
 *      the primary to the appropriate single remote action).
 *   7. Has staged files + no message → disabled "Commit" with a reason.
 *   8. Clean tree → adaptive remote action (or disabled "Commit" no-op).
 *
 * An undefined upstream status means fetchUpstreamStatus has not resolved
 * yet for this worktree. We return a disabled Commit so the button has a
 * stable frame until the real status lands — otherwise it would flash
 * through "Publish Branch" on every worktree switch.
 */
export function resolvePrimaryAction(inputs: PrimaryActionInputs): PrimaryAction {
  const {
    stagedCount,
    hasUnstagedChanges,
    hasStageableChanges,
    hasPartiallyStagedChanges,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    upstreamStatus,
    prState,
    isPRStateLoading,
    hostedReviewCreation,
    branchCommitsAhead,
    hasCurrentBranch = true,
    canPushLinkedReviewWithoutUpstream = false,
    isPrIntentInFlight = false
  } = inputs

  if (isPrIntentInFlight) {
    return resolveCreatePrIntentInFlightPrimaryAction(inputs)
  }

  // 1. Commit in flight — lock the primary no matter what else is true.
  if (isCommitting) {
    return {
      kind: 'commit',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.16aee3a5c1',
        'Commit in progress…'
      ),
      disabled: true
    }
  }

  if (isRemoteOperationActive) {
    return resolvePrimaryActionDuringRemoteOp(inputs, resolvePrimaryAction)
  }

  // 3. Unresolved conflicts block any commit path.
  if (hasUnresolvedConflicts) {
    return {
      kind: 'commit',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.a6457b46a7',
        'Resolve conflicts before committing'
      ),
      disabled: true
    }
  }

  const createPrIntent = resolveCreatePrIntentPrimaryAction(inputs)
  if (createPrIntent) {
    return createPrIntent
  }

  const hasStaged = stagedCount > 0
  const hasOpenHostedReview = prState === 'open' || prState === 'draft'

  // Why: partial staging can break hook-time restores during the intent flow;
  // keep Stage All visible as a sibling prerequisite without replacing Create PR.
  if (hasStaged && hasPartiallyStagedChanges) {
    return {
      kind: 'stage',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.18a0fca877',
        'Stage All'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.2d8f185fbc',
        'Stage all changes before committing partially staged files'
      ),
      disabled: false
    }
  }

  // 5. Has staged files + message → plain Commit. The primary button never
  //    compounds ("Commit & Push" etc.) — after the commit lands, the primary
  //    naturally rotates to the appropriate remote action (Push / Sync /
  //    Publish Branch) via step 7 below. Users who want the one-click
  //    compound flow can still reach it from the dropdown.
  if (hasStaged && hasMessage) {
    return {
      kind: 'commit',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.ab41fb926b',
        'Commit staged changes'
      ),
      disabled: false
    }
  }

  // 6. Has staged files but no message — user just needs to type something.
  if (hasStaged && !hasMessage) {
    return {
      kind: 'commit',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.f01f16d77f',
        'Enter a commit message to commit'
      ),
      disabled: true
    }
  }

  // 6b. Nothing staged but local changes exist — surface staging as the
  //     primary so dirty trees don't invite a remote op (pull/sync would fail
  //     with uncommitted changes; push/publish skips the actual user need).
  //     Sits before the upstream-status checks so it works regardless of
  //     whether upstream has resolved yet.
  if (!hasStaged && hasStageableChanges) {
    return {
      kind: 'stage',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.18a0fca877',
        'Stage All'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.5a477d80cb',
        'Stage all changes'
      ),
      disabled: false
    }
  }

  // 7. Clean tree + no staged files → adaptive remote action.
  if (!upstreamStatus) {
    return {
      kind: 'commit',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.fa3bd4f40c',
        'Stage at least one file to commit'
      ),
      disabled: true
    }
  }

  if (!upstreamStatus.hasUpstream) {
    const unpublishedAction = resolveUnpublishedPrimaryAction({
      hasCurrentBranch,
      branchCommitsAhead,
      isPRStateLoading,
      prState
    })

    if (unpublishedAction.kind === 'publish') {
      const linkedReviewAction = resolveLinkedReviewPrimaryAction({
        hasOpenHostedReview,
        canPushLinkedReviewWithoutUpstream
      })
      if (linkedReviewAction) {
        return linkedReviewAction
      }
    }

    return unpublishedAction
  }

  if (upstreamStatus.ahead > 0 && upstreamStatus.behind > 0) {
    if (shouldForcePushWithLeaseForUpstream(upstreamStatus)) {
      return {
        kind: 'push',
        label: translate(
          'auto.components.right.sidebar.source.control.primary.action.390abeab93',
          'Force Push'
        ),
        title: describeForcePushWithLease(branchCommitsAhead, upstreamStatus.upstreamName),
        disabled: false
      }
    }
    return {
      kind: 'sync',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.795f1509c5',
        'Sync'
      ),
      title: describeSyncCounts(upstreamStatus.ahead, upstreamStatus.behind),
      disabled: false
    }
  }
  if (upstreamStatus.behind > 0) {
    return {
      kind: 'pull',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.d64292a938',
        'Pull'
      ),
      title: describePullCount(upstreamStatus.behind),
      disabled: false
    }
  }
  if (upstreamStatus.ahead > 0) {
    return {
      kind: 'push',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.95550cff15',
        'Push'
      ),
      title: describePushCount(upstreamStatus.ahead),
      disabled: false
    }
  }

  if (hostedReviewCreation?.canCreate) {
    const copy = localizedHostedReviewCopy(
      resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider)
    )
    return {
      kind: 'create_pr',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
        'Create {{value0}}',
        { value0: copy.shortLabel }
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.946a8a05ea',
        'Create a {{value0}} for this branch',
        { value0: copy.reviewLabel }
      ),
      disabled: false
    }
  }

  // Clean + tracked + in sync — distinguish truly clean from work that still
  // needs staging before commit can proceed.
  return {
    kind: 'commit',
    label: translate(
      'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
      'Commit'
    ),
    title: hasUnstagedChanges
      ? 'Stage at least one file to commit'
      : 'Nothing to commit. Branch is up to date.',
    disabled: true
  }
}

export function resolveCommitAreaPrimaryAction(inputs: PrimaryActionInputs): PrimaryAction {
  // Why: review creation is additive chrome. The commit area should keep the
  // same local/remote primary action it would have without review eligibility.
  return resolvePrimaryAction({
    ...inputs,
    hostedReviewCreation: null,
    isPrIntentInFlight: false
  })
}
