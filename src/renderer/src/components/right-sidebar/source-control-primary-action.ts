// Why: split from the combined primary+dropdown module because the primary and dropdown are independent derivations with different priority ladders; together they exceed the max-lines budget and tangle unrelated concerns.

import {
  resolveSourceControlCommitAreaPrimaryActionDecision,
  resolveSourceControlPrimaryActionDecision
} from '../../../../shared/source-control-primary-action-decision'
import type { SourceControlPrimaryActionDecision } from '../../../../shared/source-control-primary-action-decision-types'
import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import type { PrimaryAction, PrimaryActionInputs } from './source-control-primary-action-types'
import {
  describeForcePushWithLease,
  describePullCount,
  describePushCount,
  describeSyncCounts
} from './source-control-primary-action-titles'

export type {
  PrimaryActionKind,
  RemoteOpKind,
  PrimaryAction,
  PrimaryActionInputs
} from './source-control-primary-action-types'

// Why: the shared module owns the pure state-machine logic; this renderer
// adapter keeps localized copy and the historical exported shape in place.

/**
 * Resolve the primary split-button action.
 *
 * Priority order mirrors the design-doc state machine:
 *   1. In-flight commit locks the primary to a disabled "Commit".
 *   2. In-flight remote operation keeps the current label but disables it.
 *   3. Unresolved conflicts block the commit path entirely.
 *   4. Create PR intent can own the primary; manual prerequisites are
 *      exposed as a visible sibling action by CommitArea.
 *   5. Has staged files + message → plain "Commit" (compound flows live in
 *      the dropdown; after the commit lands, the clean-tree rung rotates
 *      the primary to the appropriate single remote action).
 *   6. Has staged files + no message → disabled "Commit" with a reason.
 *   7. Clean tree → adaptive remote action (or disabled "Commit" no-op).
 *
 * An undefined upstream status means fetchUpstreamStatus has not resolved
 * yet for this worktree. We return a disabled Commit so the button has a
 * stable frame until the real status lands — otherwise it would flash
 * through "Publish Branch" on every worktree switch.
 */
export function resolvePrimaryAction(inputs: PrimaryActionInputs): PrimaryAction {
  return toRendererPrimaryAction(resolveSourceControlPrimaryActionDecision(inputs), inputs)
}

export function resolveCommitAreaPrimaryAction(inputs: PrimaryActionInputs): PrimaryAction {
  return toRendererPrimaryAction(
    resolveSourceControlCommitAreaPrimaryActionDecision(inputs),
    inputs
  )
}

function toRendererPrimaryAction(
  decision: SourceControlPrimaryActionDecision,
  inputs: PrimaryActionInputs
): PrimaryAction {
  return {
    kind: decision.kind,
    label: resolvePrimaryActionLabel(decision, inputs),
    title: resolvePrimaryActionTitle(decision, inputs),
    disabled: decision.disabled
  }
}

function resolvePrimaryActionLabel(
  decision: SourceControlPrimaryActionDecision,
  inputs: PrimaryActionInputs
): string {
  if (decision.labelIntent === 'force_push') {
    return translate(
      'auto.components.right.sidebar.source.control.primary.action.390abeab93',
      'Force Push'
    )
  }
  if (decision.labelIntent === 'create_pr') {
    const copy = localizedHostedReviewCopy(
      resolveSupportedHostedReviewCopyProvider(inputs.hostedReviewCreation?.provider)
    )
    return translate(
      'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
      'Create {{value0}}',
      { value0: copy.shortLabel }
    )
  }
  switch (decision.labelIntent) {
    case 'commit':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        'Commit'
      )
    case 'stage':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.18a0fca877',
        'Stage All'
      )
    case 'push':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.95550cff15',
        'Push'
      )
    case 'pull':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.d64292a938',
        'Pull'
      )
    case 'sync':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.795f1509c5',
        'Sync'
      )
    case 'publish':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.7b4d02e6b8',
        'Publish Branch'
      )
    case 'create_pr_intent':
      return resolvePrimaryActionLabel({ ...decision, labelIntent: 'create_pr' }, inputs)
  }
}

function resolvePrimaryActionTitle(
  decision: SourceControlPrimaryActionDecision,
  inputs: PrimaryActionInputs
): string {
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(inputs.hostedReviewCreation?.provider)
  )
  switch (decision.titleIntent) {
    case 'commit_in_progress':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.16aee3a5c1',
        'Commit in progress…'
      )
    case 'force_push_in_progress':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.74fc171e99',
        'Force Push in progress…'
      )
    case 'action_in_progress':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.484f45c439',
        '{{value0}} in progress…',
        { value0: resolvePrimaryActionLabel(decision, inputs) }
      )
    case 'remote_operation_in_progress':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.6f7a8b9c0d',
        'Remote operation in progress…'
      )
    case 'remote_operation_blocks_commit':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.7f8a9b0c1d',
        'Remote operation in progress — try again once it finishes'
      )
    case 'resolve_conflicts_before_commit':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.a6457b46a7',
        'Resolve conflicts before committing'
      )
    case 'prepare_review':
      if (decision.disabled) {
        return translate(
          'auto.components.right.sidebar.source.control.primary.action.d37e68f61d',
          'Preparing branch for review…'
        )
      }
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.c72e5e65d1',
        'Prepare this branch and create a {{value0}}',
        { value0: copy.reviewLabel }
      )
    case 'commit_staged_changes':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.ab41fb926b',
        'Commit staged changes'
      )
    case 'enter_commit_message':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.f01f16d77f',
        'Enter a commit message to commit'
      )
    case 'stage_all_changes':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.5a477d80cb',
        'Stage all changes'
      )
    case 'stage_file_to_commit':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.fa3bd4f40c',
        'Stage at least one file to commit'
      )
    case 'checkout_branch_before_publish':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.e61b0d7a3c',
        'Check out a branch before publishing commits.'
      )
    case 'checking_review_status':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.41d4bcf157',
        'Checking PR status…'
      )
    case 'review_already_merged':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.3d5dccef0b',
        'Nothing to commit. PR is already merged.'
      )
    case 'publish_branch':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.1884cf34af',
        'Publish this branch to origin'
      )
    case 'push_linked_review':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.1d47e850cf',
        'Push updates to the linked review branch'
      )
    case 'linked_review_target_unavailable':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.c39d0c75c3',
        'Linked review branch target is unavailable.'
      )
    case 'force_push_with_lease':
      return describeForcePushWithLease(decision.count, decision.upstreamName)
    case 'sync_counts':
      return describeSyncCounts(decision.ahead ?? 0, decision.behind ?? 0)
    case 'pull_count':
      return describePullCount(decision.count ?? 0)
    case 'push_count':
      return describePushCount(decision.count ?? 0)
    case 'create_review':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.946a8a05ea',
        'Create a {{value0}} for this branch',
        { value0: copy.reviewLabel }
      )
    case 'nothing_to_commit_up_to_date':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.8f9a0b1c2d',
        'Nothing to commit. Branch is up to date.'
      )
    case 'checking_review_creation':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.h3i4j5k607',
        'Checking whether this branch can create a {{value0}}…',
        { value0: copy.reviewLabel }
      )
  }
}
