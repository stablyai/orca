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
import { createBlockedHint as resolveCreateBlockedHint } from './source-control-dropdown-copy'

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

  const createBlockedHint = resolveCreateBlockedHint({
    blockedReason: hostedReviewCreation?.blockedReason,
    shouldForcePushWithLease,
    upstreamLoading,
    authInstruction: createReviewCopy.authInstruction,
    reviewLabel: createReviewCopy.reviewLabel
  })

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
