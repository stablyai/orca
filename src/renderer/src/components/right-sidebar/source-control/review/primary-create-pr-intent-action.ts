import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { supportsHostedReviewCreation } from '../../../../../../shared/source-control/hosted-review/hosted-review-creation-providers'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { PrimaryAction, PrimaryActionInputs } from './source-control-primary-action-types'
import { resolveCrossWorktreeWaitingAction } from './source-control-primary-action'
import { resolveCreateReviewIntentEligibility as resolveCreatePrIntentEligibility } from '../../../../../../shared/source-control/decisions/source-control-create-review-intent'
import {
  canClickBlockedCreateReviewReason,
  resolveBlockedCreateReviewNoticeMessage
} from './source-control-create-review-blocked-action'

function shouldOfferCreatePrHeaderChrome(
  hostedReviewCreation: HostedReviewCreationEligibility | null | undefined
): hostedReviewCreation is HostedReviewCreationEligibility {
  if (!supportsHostedReviewCreation(hostedReviewCreation?.provider)) {
    return false
  }
  const blockedReason = hostedReviewCreation?.blockedReason
  return blockedReason !== 'existing_review' && blockedReason !== 'unsupported_provider'
}

function buildCreatePrHeaderAction(
  hostedReviewCreation: HostedReviewCreationEligibility,
  title: string,
  disabled: boolean,
  t: Translate = translate
): PrimaryAction {
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider),
    t
  )
  return {
    kind: 'create_pr',
    label: t(
      'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
      'Create {{value0}}',
      { value0: copy.shortLabel }
    ),
    title,
    disabled
  }
}

export function resolveDisabledCreatePrHeaderAction(
  inputs: Pick<
    PrimaryActionInputs,
    'hostedReviewCreation' | 'isCommitting' | 'isRemoteOperationActive' | 'hasUnresolvedConflicts'
  >,
  t: Translate = translate
): PrimaryAction | null {
  const { hostedReviewCreation } = inputs
  if (!shouldOfferCreatePrHeaderChrome(hostedReviewCreation)) {
    return null
  }

  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider),
    t
  )

  let title: string
  if (inputs.isCommitting) {
    title = t(
      'auto.components.right.sidebar.source.control.primary.action.16aee3a5c1',
      'Commit in progress…'
    )
  } else if (inputs.isRemoteOperationActive) {
    title = t(
      'auto.components.right.sidebar.source.control.primary.action.b8e4f2a901',
      'Wait for the remote operation to finish.'
    )
  } else if (inputs.hasUnresolvedConflicts) {
    title = t(
      'auto.components.right.sidebar.source.control.primary.action.c9f3a1b802',
      'Resolve conflicts before creating a {{value0}}.',
      { value0: copy.reviewLabel }
    )
  } else {
    switch (hostedReviewCreation.blockedReason) {
      case 'default_branch':
        title = t(
          'auto.components.right.sidebar.source.control.primary.action.e3b9d5f814',
          'Cannot create a {{value0}} from the default branch.',
          { value0: copy.reviewLabel }
        )
        break
      case 'dirty':
        title = t(
          'auto.components.right.sidebar.source.control.primary.action.f4c0e6a925',
          'Commit changes before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'no_upstream':
        title = t(
          'auto.components.right.sidebar.source.control.primary.action.a5d1f7b036',
          'Publish commits before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'needs_push':
        title = t(
          'auto.components.right.sidebar.source.control.primary.action.b6e2a8c147',
          'Push commits before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'needs_sync':
        title = t(
          'auto.components.right.sidebar.source.control.primary.action.c7f3b9d258',
          'Sync this branch before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'auth_required':
        title = t(
          'auto.components.right.sidebar.source.control.primary.action.d8a4c0e369',
          'Authenticate before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'detached_head':
        title = t(
          'auto.components.right.sidebar.source.control.primary.action.e9b5d1f470',
          'Check out a branch before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'existing_review':
      case 'fork_head_unsupported':
      case 'unsupported_provider':
      case 'base_not_on_remote':
      case null:
        // A failed review lookup is not a branch problem, so name it instead.
        title =
          resolveBlockedCreateReviewNoticeMessage(hostedReviewCreation, t) ??
          t(
            'auto.components.right.sidebar.source.control.primary.action.f0c6e2a581',
            'This branch is not ready for a {{value0}} yet.',
            { value0: copy.reviewLabel }
          )
    }
  }

  const blockedByBusyState =
    inputs.isCommitting || inputs.isRemoteOperationActive || inputs.hasUnresolvedConflicts
  const disabled =
    blockedByBusyState || !canClickBlockedCreateReviewReason(hostedReviewCreation.blockedReason)
  return buildCreatePrHeaderAction(hostedReviewCreation, title, disabled, t)
}

export function resolveCreatePrIntentInFlightPrimaryAction(
  inputs?: PrimaryActionInputs,
  t: Translate = translate
): PrimaryAction {
  const waitingAction = inputs && resolveCrossWorktreeWaitingAction(inputs, 'create_pr_intent', t)
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(inputs?.hostedReviewCreation?.provider),
    t
  )

  return (
    waitingAction ?? {
      kind: 'create_pr_intent',
      label: t(
        'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
        'Create {{value0}}',
        { value0: copy.shortLabel }
      ),
      title: t(
        'auto.components.right.sidebar.source.control.primary.action.d37e68f61d',
        'Preparing branch for review…'
      ),
      disabled: true
    }
  )
}

export function resolveCreatePrIntentPrimaryAction(
  inputs: PrimaryActionInputs,
  t: Translate = translate
): PrimaryAction | null {
  const createPrIntent = resolveCreatePrIntentEligibility({
    stagedCount: inputs.stagedCount,
    hasStageableChanges: inputs.hasStageableChanges,
    hasMessage: inputs.hasMessage,
    hasUnresolvedConflicts: inputs.hasUnresolvedConflicts,
    upstreamStatus: inputs.upstreamStatus,
    hostedReviewCreation: inputs.hostedReviewCreation,
    branchCommitsAhead: inputs.branchCommitsAhead,
    hasCurrentBranch: inputs.hasCurrentBranch
  })
  if (!createPrIntent.eligible) {
    return null
  }
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(inputs.hostedReviewCreation?.provider),
    t
  )
  return {
    kind: 'create_pr_intent',
    label: t(
      'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
      'Create {{value0}}',
      { value0: copy.shortLabel }
    ),
    title: t(
      'auto.components.right.sidebar.source.control.primary.action.c72e5e65d1',
      'Prepare this branch and create a {{value0}}',
      { value0: copy.reviewLabel }
    ),
    disabled: false
  }
}

function resolveLoadingCreatePrHeaderAction(
  hostedReviewCreation: HostedReviewCreationEligibility,
  t: Translate = translate
): PrimaryAction | null {
  if (!shouldOfferCreatePrHeaderChrome(hostedReviewCreation)) {
    return null
  }
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider),
    t
  )
  return buildCreatePrHeaderAction(
    hostedReviewCreation,
    t(
      'auto.components.right.sidebar.source.control.primary.action.h3i4j5k607',
      'Checking whether this branch can create a {{value0}}…',
      { value0: copy.reviewLabel }
    ),
    true,
    t
  )
}

export function resolveCreatePrHeaderAction(
  inputs: PrimaryActionInputs,
  t: Translate = translate
): PrimaryAction | null {
  if (inputs.isPrIntentInFlight) {
    return resolveCreatePrIntentInFlightPrimaryAction(inputs, t)
  }

  if (inputs.isHostedReviewCreationLoading && inputs.hostedReviewCreation) {
    return resolveLoadingCreatePrHeaderAction(inputs.hostedReviewCreation, t)
  }

  if (inputs.isCommitting || inputs.isRemoteOperationActive || inputs.hasUnresolvedConflicts) {
    return resolveDisabledCreatePrHeaderAction(inputs, t)
  }

  if (inputs.hostedReviewCreation?.canCreate) {
    const copy = localizedHostedReviewCopy(
      resolveSupportedHostedReviewCopyProvider(inputs.hostedReviewCreation.provider),
      t
    )
    return {
      kind: 'create_pr',
      label: t(
        'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
        'Create {{value0}}',
        { value0: copy.shortLabel }
      ),
      title: t(
        'auto.components.right.sidebar.source.control.primary.action.946a8a05ea',
        'Create a {{value0}} for this branch',
        { value0: copy.reviewLabel }
      ),
      disabled: false
    }
  }

  const createPrIntent = resolveCreatePrIntentPrimaryAction(inputs, t)
  if (createPrIntent) {
    return createPrIntent
  }

  return resolveDisabledCreatePrHeaderAction(inputs, t)
}
