import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import type { PrimaryAction, PrimaryActionInputs } from './source-control-primary-action-types'
import { resolveCreatePrIntentEligibility } from './source-control-create-pr-intent-state'

export function resolveProvisionalHostedReviewProvider(input: {
  hostedReview?: Pick<HostedReviewInfo, 'provider'> | null
  hostedReviewCreationState?: {
    repoId: string
    data: Pick<HostedReviewCreationEligibility, 'provider'>
  } | null
  activeRepoId?: string | null
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}): HostedReviewProvider {
  if (input.hostedReview?.provider && supportsHostedReviewCreation(input.hostedReview.provider)) {
    return input.hostedReview.provider
  }
  if (
    input.hostedReviewCreationState &&
    input.activeRepoId === input.hostedReviewCreationState.repoId &&
    supportsHostedReviewCreation(input.hostedReviewCreationState.data.provider)
  ) {
    return input.hostedReviewCreationState.data.provider
  }
  if (input.linkedGitLabMR != null) {
    return 'gitlab'
  }
  if (input.linkedAzureDevOpsPR != null) {
    return 'azure-devops'
  }
  if (input.linkedGiteaPR != null) {
    return 'gitea'
  }
  if (input.linkedGitHubPR != null || input.fallbackGitHubPR != null) {
    return 'github'
  }
  return 'github'
}

export function buildLoadingHostedReviewCreationEligibility(
  provider: HostedReviewProvider
): HostedReviewCreationEligibility {
  return {
    provider,
    review: null,
    canCreate: false,
    blockedReason: null,
    nextAction: null
  }
}

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
  disabled: boolean
): PrimaryAction {
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
    title,
    disabled
  }
}

export function resolveDisabledCreatePrHeaderAction(
  inputs: Pick<
    PrimaryActionInputs,
    'hostedReviewCreation' | 'isCommitting' | 'isRemoteOperationActive' | 'hasUnresolvedConflicts'
  >,
  options?: { noBranchChanges?: boolean }
): PrimaryAction | null {
  const { hostedReviewCreation } = inputs
  if (!shouldOfferCreatePrHeaderChrome(hostedReviewCreation)) {
    return null
  }

  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider)
  )

  let title: string
  if (inputs.isCommitting) {
    title = translate(
      'auto.components.right.sidebar.source.control.primary.action.16aee3a5c1',
      'Commit in progress…'
    )
  } else if (inputs.isRemoteOperationActive) {
    title = translate(
      'auto.components.right.sidebar.source.control.primary.action.b8e4f2a901',
      'Wait for the remote operation to finish.'
    )
  } else if (inputs.hasUnresolvedConflicts) {
    title = translate(
      'auto.components.right.sidebar.source.control.primary.action.c9f3a1b802',
      'Resolve conflicts before creating a {{value0}}.',
      { value0: copy.reviewLabel }
    )
  } else if (options?.noBranchChanges) {
    title = translate(
      'auto.components.right.sidebar.source.control.primary.action.d2a8c4e703',
      'No changes on this branch to include in a {{value0}}.',
      { value0: copy.reviewLabel }
    )
  } else {
    switch (hostedReviewCreation.blockedReason) {
      case 'default_branch':
        title = translate(
          'auto.components.right.sidebar.source.control.primary.action.e3b9d5f814',
          'Cannot create a {{value0}} from the default branch.',
          { value0: copy.reviewLabel }
        )
        break
      case 'dirty':
        title = translate(
          'auto.components.right.sidebar.source.control.primary.action.f4c0e6a925',
          'Commit changes before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'no_upstream':
        title = translate(
          'auto.components.right.sidebar.source.control.primary.action.a5d1f7b036',
          'Publish commits before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'needs_push':
        title = translate(
          'auto.components.right.sidebar.source.control.primary.action.b6e2a8c147',
          'Push commits before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'needs_sync':
        title = translate(
          'auto.components.right.sidebar.source.control.primary.action.c7f3b9d258',
          'Sync this branch before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'auth_required':
        title = translate(
          'auto.components.right.sidebar.source.control.primary.action.d8a4c0e369',
          'Authenticate before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'detached_head':
        title = translate(
          'auto.components.right.sidebar.source.control.primary.action.e9b5d1f470',
          'Check out a branch before creating a {{value0}}.',
          { value0: copy.reviewLabel }
        )
        break
      case 'existing_review':
      case 'fork_head_unsupported':
      case 'unsupported_provider':
      case null:
        title = translate(
          'auto.components.right.sidebar.source.control.primary.action.f0c6e2a581',
          'This branch is not ready for a {{value0}} yet.',
          { value0: copy.reviewLabel }
        )
    }
  }

  return buildCreatePrHeaderAction(hostedReviewCreation, title, true)
}

export function resolveCreatePrIntentInFlightPrimaryAction(
  inputs?: Pick<PrimaryActionInputs, 'hostedReviewCreation'>
): PrimaryAction {
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(inputs?.hostedReviewCreation?.provider)
  )

  return {
    kind: 'create_pr_intent',
    label: translate(
      'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
      'Create {{value0}}',
      { value0: copy.shortLabel }
    ),
    title: translate(
      'auto.components.right.sidebar.source.control.primary.action.d37e68f61d',
      'Preparing branch for review…'
    ),
    disabled: true
  }
}

export function resolveCreatePrIntentPrimaryAction(
  inputs: PrimaryActionInputs
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
    resolveSupportedHostedReviewCopyProvider(inputs.hostedReviewCreation?.provider)
  )
  return {
    kind: 'create_pr_intent',
    label: translate(
      'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
      'Create {{value0}}',
      { value0: copy.shortLabel }
    ),
    title: translate(
      'auto.components.right.sidebar.source.control.primary.action.c72e5e65d1',
      'Prepare this branch and create a {{value0}}',
      { value0: copy.reviewLabel }
    ),
    disabled: false
  }
}

function resolveLoadingCreatePrHeaderAction(
  hostedReviewCreation: HostedReviewCreationEligibility
): PrimaryAction | null {
  if (!shouldOfferCreatePrHeaderChrome(hostedReviewCreation)) {
    return null
  }
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider)
  )
  return buildCreatePrHeaderAction(
    hostedReviewCreation,
    translate(
      'auto.components.right.sidebar.source.control.primary.action.h3i4j5k607',
      'Checking whether this branch can create a {{value0}}…',
      { value0: copy.reviewLabel }
    ),
    true
  )
}

export function resolveCreatePrHeaderAction(inputs: PrimaryActionInputs): PrimaryAction | null {
  if (inputs.isPrIntentInFlight) {
    return resolveCreatePrIntentInFlightPrimaryAction(inputs)
  }

  if (inputs.isHostedReviewCreationLoading && inputs.hostedReviewCreation) {
    return resolveLoadingCreatePrHeaderAction(inputs.hostedReviewCreation)
  }

  if (inputs.isCommitting || inputs.isRemoteOperationActive || inputs.hasUnresolvedConflicts) {
    return resolveDisabledCreatePrHeaderAction(inputs)
  }

  if (inputs.hostedReviewCreation?.canCreate) {
    const copy = localizedHostedReviewCopy(
      resolveSupportedHostedReviewCopyProvider(inputs.hostedReviewCreation.provider)
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

  return resolveCreatePrIntentPrimaryAction(inputs) ?? resolveDisabledCreatePrHeaderAction(inputs)
}
