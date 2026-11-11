// Share creation blockers so Create and Push-before-PR tooltips cannot disagree.

import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { supportsHostedReviewCreation } from '../../../../../../shared/source-control/hosted-review/hosted-review-creation-providers'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { canClickBlockedCreateReviewReason } from './source-control-create-review-blocked-action'
import { hostedReviewSignInHint } from '../../hosted-review/provider-actions/hosted-review-sign-in-copy'
import type { DropdownItem } from '../../../../../../shared/source-control/dropdown/source-control-dropdown-item-types'
import type { DropdownActionContext } from '../../../../../../shared/source-control/dropdown/source-control-dropdown-action-context'

export type HostedReviewDropdownItems = {
  createPR: DropdownItem
  pushCreatePR: DropdownItem
}

export function buildHostedReviewDropdownItems(
  ctx: DropdownActionContext,
  t: Translate = translate
): HostedReviewDropdownItems {
  const { hostedReviewCreation, globalBusy, upstreamLoading, shouldForcePushWithLease } = ctx
  const createReviewCopy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation?.provider),
    t
  )

  const createBlockedHint = ((): string => {
    switch (hostedReviewCreation?.blockedReason) {
      case 'dirty':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedCommitFirst',
          'Commit changes first'
        )
      case 'detached_head':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedCheckOutBranchFirst',
          'Check out a branch first'
        )
      case 'default_branch':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedSwitchToFeatureBranch',
          'Switch to a feature branch'
        )
      case 'no_upstream':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedPublishBranch',
          'Publish Branch'
        )
      case 'needs_push':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedPushFirst',
          'Push first'
        )
      case 'needs_sync':
        return shouldForcePushWithLease
          ? t(
              'auto.components.right.sidebar.source.control.dropdown.items.blockedForcePushFirst',
              'Force Push first'
            )
          : t(
              'auto.components.right.sidebar.source.control.dropdown.items.blockedSyncFirst',
              'Sync first'
            )
      case 'auth_required':
        return hostedReviewSignInHint(hostedReviewCreation?.provider, t)
      case 'unsupported_provider':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedUnsupportedProvider',
          'Unsupported provider'
        )
      case 'existing_review':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedExistingReview',
          'A {{reviewLabel}} already exists',
          { reviewLabel: createReviewCopy.reviewLabel }
        )
      case 'fork_head_unsupported':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedForkHeadUnsupported',
          'Fork head unsupported'
        )
      case 'base_not_on_remote':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.blockedBaseNotOnRemote',
          'Base branch is not on the remote'
        )
      case null:
      case undefined:
        return upstreamLoading
          ? t(
              'auto.components.right.sidebar.source.control.dropdown.items.checkingBranchStatus',
              'Checking branch status…'
            )
          : t(
              'auto.components.right.sidebar.source.control.dropdown.items.blockedBranchNotReady',
              'Branch is not ready'
            )
    }
  })()

  const createBlockedStatus = ((): string | undefined => {
    switch (hostedReviewCreation?.blockedReason) {
      case 'dirty':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusCommitFirst',
          'Commit first'
        )
      case 'detached_head':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusNoBranch',
          'No branch'
        )
      case 'existing_review':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusReviewOpen',
          '{{shortLabel}} open',
          {
            shortLabel: createReviewCopy.shortLabel
          }
        )
      case 'no_upstream':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusNotPublished',
          'Not published'
        )
      case 'auth_required':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusSignIn',
          'Sign in'
        )
      case 'base_not_on_remote':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusBaseNotOnRemote',
          'Base not on remote'
        )
      case 'default_branch':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusDefaultBranch',
          'Default branch'
        )
      case 'fork_head_unsupported':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusForkUnsupported',
          'Fork unsupported'
        )
      case 'needs_push':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusPushFirst',
          'Push first'
        )
      case 'needs_sync':
        return shouldForcePushWithLease
          ? t(
              'auto.components.right.sidebar.source.control.dropdown.items.statusForcePushFirst',
              'Force push first'
            )
          : t(
              'auto.components.right.sidebar.source.control.dropdown.items.statusSyncFirst',
              'Sync first'
            )
      case 'unsupported_provider':
        return t(
          'auto.components.right.sidebar.source.control.dropdown.items.statusUnsupported',
          'Unsupported'
        )
      case null:
      case undefined:
        return undefined
    }
  })()

  const createPR: DropdownItem = {
    kind: 'create_pr',
    label: t(
      'auto.components.right.sidebar.source.control.dropdown.items.9e779995dd',
      'Create {{value0}}',
      { value0: createReviewCopy.shortLabel }
    ),
    title: hostedReviewCreation?.canCreate
      ? t(
          'auto.components.right.sidebar.source.control.dropdown.items.titleCreateReviewForBranch',
          'Create a {{reviewLabel}} for this branch',
          { reviewLabel: createReviewCopy.reviewLabel }
        )
      : createBlockedHint,
    hint: hostedReviewCreation?.canCreate ? undefined : createBlockedHint,
    status: hostedReviewCreation?.canCreate ? undefined : createBlockedStatus,
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
      ? t(
          'auto.components.right.sidebar.source.control.dropdown.items.forcePushBeforeReview',
          'Force Push before {{shortLabel}}',
          {
            shortLabel: createReviewCopy.shortLabel
          }
        )
      : t(
          'auto.components.right.sidebar.source.control.dropdown.items.pushBeforeReview',
          'Push before {{shortLabel}}',
          {
            shortLabel: createReviewCopy.shortLabel
          }
        ),
    title: canPushAndCreate
      ? shouldForcePushWithLease
        ? t(
            'auto.components.right.sidebar.source.control.dropdown.items.titleForcePushBeforeCreatingReview',
            'Force push with lease before creating a {{reviewLabel}}',
            { reviewLabel: createReviewCopy.reviewLabel }
          )
        : t(
            'auto.components.right.sidebar.source.control.dropdown.items.titlePushBeforeCreatingReview',
            'Push local commits before creating a {{reviewLabel}}',
            { reviewLabel: createReviewCopy.reviewLabel }
          )
      : createBlockedHint,
    hint: canPushAndCreate ? undefined : createBlockedHint,
    status: canPushAndCreate ? undefined : createBlockedStatus,
    disabled: !canPushAndCreate
  }

  return { createPR, pushCreatePR }
}
