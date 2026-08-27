// Why: the two review-creation rows share one blocked-reason string, so the "Push first" hint on
// Create PR and the tooltip on Push-before-PR can never disagree.

import { translate } from '@/i18n/i18n'
import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import {
  canClickBlockedCreateReviewReason,
  resolveHostedReviewAuthInstruction
} from './source-control-create-review-blocked-action'
import type { PrimaryActionInputs } from './source-control-primary-action'
import type { DropdownItem } from './source-control-dropdown-item-types'
import type { DropdownActionContext } from './source-control-dropdown-action-context'

export type HostedReviewDropdownItems = {
  createPR: DropdownItem
  pushCreatePR: DropdownItem
}

function reviewCopy(
  provider: NonNullable<PrimaryActionInputs['hostedReviewCreation']>['provider'] | undefined
): ReturnType<typeof localizedHostedReviewCopy> & {
  authInstruction: string
} {
  return {
    ...localizedHostedReviewCopy(resolveSupportedHostedReviewCopyProvider(provider)),
    authInstruction: resolveHostedReviewAuthInstruction(provider ?? 'github')
  }
}

export function buildHostedReviewDropdownItems(
  ctx: DropdownActionContext
): HostedReviewDropdownItems {
  const { hostedReviewCreation, globalBusy, upstreamLoading, shouldForcePushWithLease } = ctx
  const createReviewCopy = reviewCopy(hostedReviewCreation?.provider)

  const createBlockedHint = ((): string => {
    switch (hostedReviewCreation?.blockedReason) {
      case 'dirty':
        return 'Commit changes first'
      case 'detached_head':
        return 'Check out a branch first'
      case 'default_branch':
        return 'Switch to a feature branch'
      case 'no_upstream':
        return 'Publish Branch'
      case 'needs_push':
        return 'Push first'
      case 'needs_sync':
        return shouldForcePushWithLease ? 'Force Push first' : 'Sync first'
      case 'auth_required':
        return `${createReviewCopy.authInstruction} in this environment`
      case 'unsupported_provider':
        return 'Unsupported provider'
      case 'existing_review':
        return `A ${createReviewCopy.reviewLabel} already exists`
      case 'fork_head_unsupported':
        return 'Fork head unsupported'
      case 'base_not_on_remote':
        return 'Base branch is not on the remote'
      case null:
      case undefined:
        return upstreamLoading ? 'Checking branch status…' : 'Branch is not ready'
    }
  })()

  const createPR: DropdownItem = {
    kind: 'create_pr',
    label: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.9e779995dd',
      'Create {{value0}}',
      { value0: createReviewCopy.shortLabel }
    ),
    title: hostedReviewCreation?.canCreate
      ? `Create a ${createReviewCopy.reviewLabel} for this branch`
      : createBlockedHint,
    hint: hostedReviewCreation?.canCreate ? undefined : createBlockedHint,
    disabled:
      globalBusy ||
      !supportsHostedReviewCreation(hostedReviewCreation?.provider) ||
      (!hostedReviewCreation?.canCreate &&
        !canClickBlockedCreateReviewReason(hostedReviewCreation?.blockedReason))
  }

  const canPushAndCreate =
    !globalBusy &&
    !upstreamLoading &&
    supportsHostedReviewCreation(hostedReviewCreation?.provider) &&
    (hostedReviewCreation.blockedReason === 'needs_push' ||
      (hostedReviewCreation.blockedReason === 'needs_sync' && shouldForcePushWithLease))
  const pushCreatePR: DropdownItem = {
    kind: 'push_create_pr',
    label: shouldForcePushWithLease
      ? `Force Push before ${createReviewCopy.shortLabel}`
      : `Push before ${createReviewCopy.shortLabel}`,
    title: canPushAndCreate
      ? shouldForcePushWithLease
        ? `Force push with lease before creating a ${createReviewCopy.reviewLabel}`
        : `Push local commits before creating a ${createReviewCopy.reviewLabel}`
      : createBlockedHint,
    hint: canPushAndCreate ? undefined : createBlockedHint,
    disabled: !canPushAndCreate
  }

  return { createPR, pushCreatePR }
}
