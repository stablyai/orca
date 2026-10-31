import type {
  CreateHostedReviewFailureReason,
  CreateHostedReviewResult,
  CreateStackedHostedReviewResult,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'
import { isStackedReviewFailureReason } from '../../../../shared/stacked-hosted-review-failure-copy'
import { stackedFailureMessage } from './stacked-review-create-failure-copy'
import { authRequiredDetail } from './hosted-review-sign-in-copy'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider,
  type LocalizedHostedReviewCopy,
  type SupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'

type FailedCreateResult =
  | Extract<CreateHostedReviewResult, { ok: false }>
  | Extract<CreateStackedHostedReviewResult, { ok: false }>

/** `detail` follows "Create PR failed:"; `message` stands alone. */
type CreateFailureCopy = { kind: 'detail' | 'message'; text: string }

// Returns undefined for a reason from a newer host that this build does not know.
function createFailureCopy(
  reason: CreateHostedReviewFailureReason,
  provider: SupportedHostedReviewCopyProvider,
  copy: LocalizedHostedReviewCopy,
  base: string | undefined,
  head?: string
): CreateFailureCopy | undefined {
  if (isStackedReviewFailureReason(reason)) {
    const text = stackedFailureMessage(reason, base, head)
    return text === undefined ? undefined : { kind: 'message', text }
  }
  const vars = {
    reviewLabel: copy.reviewLabel,
    shortLabel: copy.shortLabel,
    providerName: copy.providerName
  }
  const detail = (text: string): CreateFailureCopy => ({ kind: 'detail', text })
  const message = (text: string): CreateFailureCopy => ({ kind: 'message', text })
  switch (reason) {
    case 'auth_required':
      return detail(authRequiredDetail(provider, copy))
    case 'dirty':
      return detail(
        translate(
          'sourceControl.createReviewFailure.dirty',
          'commit or discard local changes before creating a {{reviewLabel}}.',
          vars
        )
      )
    case 'detached_head':
      return detail(
        translate(
          'sourceControl.createReviewFailure.detachedHead',
          'switch to a branch before creating a {{reviewLabel}}.',
          vars
        )
      )
    case 'default_branch':
      return detail(
        translate(
          'sourceControl.createReviewFailure.defaultBranch',
          'choose a feature branch before creating a {{reviewLabel}}.',
          vars
        )
      )
    case 'no_upstream':
      return detail(
        translate(
          'sourceControl.createReviewFailure.noUpstream',
          'publish this branch before creating a {{reviewLabel}}.',
          vars
        )
      )
    case 'needs_push':
      return detail(
        translate(
          'sourceControl.createReviewFailure.needsPush',
          'push this branch before creating a {{reviewLabel}}.',
          vars
        )
      )
    case 'needs_sync':
      return detail(
        translate(
          'sourceControl.createReviewFailure.needsSync',
          'sync this branch before creating a {{reviewLabel}}.',
          vars
        )
      )
    case 'fork_head_unsupported':
      return detail(
        translate(
          'sourceControl.createReviewFailure.refreshStatus',
          'refresh source control status and try again.'
        )
      )
    case 'base_not_on_remote':
      return detail(
        base
          ? translate(
              'sourceControl.createReviewFailure.namedBaseNotOnRemote',
              'the base branch "{{base}}" hasn\'t been pushed to the remote. Choose a pushed base or push it first.',
              { base }
            )
          : translate(
              'sourceControl.createReviewFailure.baseNotOnRemote',
              "the base branch hasn't been pushed to the remote. Choose a pushed base or push it first."
            )
      )
    case 'branch_changed':
      return detail(
        translate(
          'sourceControl.createReviewFailure.branchChanged',
          'switch back to the selected branch before creating a {{reviewLabel}}.',
          vars
        )
      )
    case 'branch_status_unverified':
      return detail(
        translate(
          'sourceControl.createReviewFailure.branchStatusUnverified',
          'could not verify branch status. Refresh source control and try again.'
        )
      )
    case 'review_lookup_unavailable':
      return detail(
        translate(
          'sourceControl.createReviewFailure.reviewLookupUnavailable',
          'Orca could not confirm whether this branch already has a {{reviewLabel}}. Retry once the {{providerName}} lookup succeeds.',
          vars
        )
      )
    case 'same_base_branch':
      return detail(
        translate(
          'sourceControl.createReviewFailure.sameBaseBranch',
          'choose a different base branch before creating a {{reviewLabel}}.',
          vars
        )
      )
    case 'base_head_title_required':
      return detail(
        translate(
          'sourceControl.createReviewFailure.baseHeadTitleRequired',
          'base branch, head branch, and title are required.'
        )
      )
    case 'rejected':
      return detail(
        translate(
          'sourceControl.createReviewFailure.rejected',
          '{{providerName}} rejected the {{reviewLabel}}. Check the base branch and branch state, then try again.',
          vars
        )
      )
    case 'repository_not_found':
      return detail(
        translate(
          'sourceControl.createReviewFailure.repositoryNotFound',
          '{{providerName}} could not find the repository. Check that the credential has write access to it.',
          vars
        )
      )
    case 'create_failed':
      return detail(
        translate(
          'sourceControl.createReviewFailure.createFailed',
          '{{providerName}} could not create the {{reviewLabel}}. Try again in a moment.',
          vars
        )
      )
    case 'unsupported_provider':
      return message(
        translate(
          'sourceControl.createReviewFailure.unsupportedProvider',
          'Creating a {{reviewLabel}} requires a remote hosted on {{providerName}}.',
          vars
        )
      )
    case 'provider_not_supported':
      return message(
        translate(
          'sourceControl.createReviewFailure.providerNotSupported',
          'Creating reviews for this provider is not supported yet.'
        )
      )
    case 'existing_review':
      return message(
        translate(
          'sourceControl.createReviewFailure.existingReview',
          'A {{reviewLabel}} already exists for this branch.',
          vars
        )
      )
    case 'creation_unconfirmed':
      return message(
        translate(
          'sourceControl.createReviewFailure.creationUnconfirmed',
          '{{shortLabel}} creation may have completed. Refreshing branch review state...',
          vars
        )
      )
  }
}

function failureCopyFor(
  reason: CreateHostedReviewFailureReason,
  provider: HostedReviewProvider,
  base?: string,
  head?: string
): { copy: CreateFailureCopy; shortLabel: string } | null {
  const supported = resolveSupportedHostedReviewCopyProvider(provider)
  const labels = localizedHostedReviewCopy(supported)
  const copy = createFailureCopy(reason, supported, labels, base, head)
  return copy ? { copy, shortLabel: labels.shortLabel } : null
}

/** The sentence for an Orca-authored create failure in the UI language, or null for an unknown reason. */
export function hostedReviewCreateFailureMessage(
  reason: CreateHostedReviewFailureReason,
  provider: HostedReviewProvider,
  base?: string,
  head?: string
): string | null {
  const resolved = failureCopyFor(reason, provider, base, head)
  if (!resolved) {
    return null
  }
  if (resolved.copy.kind === 'message') {
    return resolved.copy.text
  }
  return translate(
    'sourceControl.createReviewFailure.withDetail',
    'Create {{shortLabel}} failed: {{detail}}',
    { shortLabel: resolved.shortLabel, detail: resolved.copy.text }
  )
}

function failedHead(result: FailedCreateResult): string | undefined {
  return 'head' in result ? result.head : undefined
}

// Hosts that send no reason only have the English sentence to strip.
const ENGLISH_CREATE_FAILED_PREFIX = /^Create (?:PR|MR) failed:\s*/i

/** A failed create result in the UI language; hosts that send no reason keep their English `error`. */
export function localizedCreateFailure(
  result: FailedCreateResult,
  provider: HostedReviewProvider
): string {
  return (
    (result.reason
      ? hostedReviewCreateFailureMessage(result.reason, provider, result.base, failedHead(result))
      : null) ?? result.error
  )
}

/** Like localizedCreateFailure, without the "Create PR failed:" lead-in. */
export function localizedCreateFailureDetail(
  result: FailedCreateResult,
  provider: HostedReviewProvider
): string {
  return (
    (result.reason
      ? failureCopyFor(result.reason, provider, result.base, failedHead(result))?.copy.text
      : null) ?? result.error.replace(ENGLISH_CREATE_FAILED_PREFIX, '')
  )
}
