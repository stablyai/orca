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
  localizedForcePushWithLease,
  localizedPullCount,
  localizedPushCount,
  localizedSyncCounts
} from './source-control-count-localized-copy'

export type {
  PrimaryActionKind,
  RemoteOpKind,
  PrimaryAction,
  PrimaryActionInputs
} from './source-control-primary-action-types'

// Shared code owns the state machine; this adapter preserves localized copy and renderer exports.

/** Keep action priority in the shared resolver; undefined upstream remains loading to avoid transient Publish labels on switches. */
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
      return localizedForcePushWithLease(decision.count, decision.upstreamName)
    case 'sync_counts':
      return localizedSyncCounts(decision.ahead ?? 0, decision.behind ?? 0)
    case 'pull_count':
      return localizedPullCount(decision.count ?? 0)
    case 'push_count':
      return localizedPushCount(decision.count ?? 0)
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
