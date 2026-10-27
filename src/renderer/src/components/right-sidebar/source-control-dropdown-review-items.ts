// Share creation blockers so Create and Push-before-PR tooltips cannot disagree.

import { translate } from '@/i18n/i18n'
import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { canClickBlockedCreateReviewReason } from './source-control-create-review-blocked-action'
import { hostedReviewSignInHint } from './hosted-review-create-failure-copy'
import type { DropdownItem } from '../../../../shared/source-control-dropdown-item-types'
import type { DropdownActionContext } from '../../../../shared/source-control-dropdown-action-context'

export type HostedReviewDropdownItems = {
  createPR: DropdownItem
  pushCreatePR: DropdownItem
}

export function buildHostedReviewDropdownItems(
  ctx: DropdownActionContext
): HostedReviewDropdownItems {
  const { hostedReviewCreation, globalBusy, upstreamLoading, shouldForcePushWithLease } = ctx
  const createReviewCopy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation?.provider)
  )

  const createBlockedHint = ((): string => {
    switch (hostedReviewCreation?.blockedReason) {
      case 'dirty':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedCommitFirst',
          'Commit changes first'
        )
      case 'detached_head':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedCheckOutBranchFirst',
          'Check out a branch first'
        )
      case 'default_branch':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedSwitchToFeatureBranch',
          'Switch to a feature branch'
        )
      case 'no_upstream':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedPublishBranch',
          'Publish Branch'
        )
      case 'needs_push':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedPushFirst',
          'Push first'
        )
      case 'needs_sync':
        return shouldForcePushWithLease
          ? translate(
              'auto.components.right.sidebar.source.control.dropdown.items.blockedForcePushFirst',
              'Force Push first'
            )
          : translate(
              'auto.components.right.sidebar.source.control.dropdown.items.blockedSyncFirst',
              'Sync first'
            )
      case 'auth_required':
        return hostedReviewSignInHint(hostedReviewCreation?.provider)
      case 'unsupported_provider':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedUnsupportedProvider',
          'Unsupported provider'
        )
      case 'existing_review':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedExistingReview',
          'A {{reviewLabel}} already exists',
          { reviewLabel: createReviewCopy.reviewLabel }
        )
      case 'fork_head_unsupported':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedForkHeadUnsupported',
          'Fork head unsupported'
        )
      case 'base_not_on_remote':
        return translate(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedBaseNotOnRemote',
          'Base branch is not on the remote'
        )
      case null:
      case undefined:
        return upstreamLoading
          ? translate(
              'auto.components.right.sidebar.source.control.dropdown.items.checkingBranchStatus',
              'Checking branch status…'
            )
          : translate(
              'auto.components.right.sidebar.source.control.dropdown.items.blockedBranchNotReady',
              'Branch is not ready'
            )
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
