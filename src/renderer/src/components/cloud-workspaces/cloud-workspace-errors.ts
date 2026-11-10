// Copy for control-plane error codes from the team workspace registry.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getLastBillingStatus } from '@/components/billing/billing-summary-store'
import { sandboxLimitFromBilling } from '@/components/worktree-creation/vm-build-failure-copy'

/**
 * Whose seat a start counts against. The per-seat running cap counts the workspace owner's seat,
 * not the seat of whoever wakes or opens it (control plane `requireStart(row.user_id)`).
 */
export type CloudWorkspaceSeatOwner = { self: boolean; name: string | null }

export function describeError(
  error: string,
  reason?: string,
  t: Translate = translate,
  owner?: CloudWorkspaceSeatOwner
): string {
  if (error === 'not_found') {
    return t(
      'auto.components.cloudWorkspaces.errorNotFound',
      'This workspace is private, archived or no longer exists.'
    )
  }
  if (error === 'entitlement_denied') {
    if (reason === 'concurrency_limit') {
      const limit = sandboxLimitFromBilling(getLastBillingStatus())
      return limit
        ? t(
            'auto.components.cloudWorkspaces.errorConcurrencyLimitCount2',
            'Your team can run {{value0}} sandboxes at once ({{value1}} per seat). Put one to sleep or delete it, then try again.',
            { value0: String(limit.team), value1: String(limit.perSeat) }
          )
        : t(
            'auto.components.cloudWorkspaces.errorConcurrencyLimit',
            "You're at your team's limit of running sandboxes. Put one to sleep or delete it, then try again."
          )
    }
    if (reason === 'member_concurrency_limit') {
      return describeSeatLimit(owner, t)
    }
    return t(
      'auto.components.cloudWorkspaces.errorEntitlementDenied',
      "Your team's plan can't start this workspace right now. Your files are safe. Ask an owner or admin to check the plan."
    )
  }
  if (error === 'forbidden') {
    return t(
      'auto.components.cloudWorkspaces.errorForbidden',
      'Only the workspace owner or a team admin can do that. Ask an owner or admin to make the change.'
    )
  }
  if (error === 'conflict') {
    return reason === 'too_many_devices'
      ? t(
          'auto.components.cloudWorkspaces.errorTooManyDevices',
          'Too many of your computers are connected to this workspace. Disconnect one, then try again.'
        )
      : t(
          'auto.components.cloudWorkspaces.errorConflict',
          'This workspace is still starting or going to sleep. Nothing was changed. Try again in a moment.'
        )
  }
  if (error === 'timeout' || error === 'unavailable' || error === 'provider_unavailable') {
    return t(
      'auto.components.cloudWorkspaces.errorUnreachable',
      "Orca Cloud isn't reachable right now. Nothing was changed. Try again."
    )
  }
  if (error === 'unauthorized') {
    return t(
      'auto.components.cloudWorkspaces.errorUnauthorized',
      'Your Orca Cloud session expired. Sign in again.'
    )
  }
  return t(
    'auto.components.cloudWorkspaces.errorUnknown',
    'Something went wrong. Nothing was changed. Try again.'
  )
}

/**
 * The same messages for an inline error that already carries the action button (Retry or Sign
 * in), so the body does not repeat "Try again." or "Sign in again.".
 */
export function describeInlineError(
  error: string,
  reason?: string,
  t: Translate = translate
): string {
  if (error === 'unauthorized') {
    return t(
      'auto.components.cloudWorkspaces.errorUnauthorizedInline',
      'Your Orca Cloud session expired.'
    )
  }
  if (error === 'timeout' || error === 'unavailable' || error === 'provider_unavailable') {
    return t(
      'auto.components.cloudWorkspaces.errorUnreachableInline',
      "Orca Cloud isn't reachable right now. Nothing was changed."
    )
  }
  if (error === 'conflict' && reason !== 'too_many_devices') {
    return t(
      'auto.components.cloudWorkspaces.errorConflictInline',
      'This workspace is still starting or going to sleep. Nothing was changed.'
    )
  }
  if (
    error === 'not_found' ||
    error === 'entitlement_denied' ||
    error === 'forbidden' ||
    error === 'conflict'
  ) {
    return describeError(error, reason, t)
  }
  return t(
    'auto.components.cloudWorkspaces.errorUnknownInline',
    'Something went wrong. Nothing was changed.'
  )
}

function describeSeatLimit(owner: CloudWorkspaceSeatOwner | undefined, t: Translate): string {
  const perSeat = sandboxLimitFromBilling(getLastBillingStatus())?.perSeat
  if (!owner || owner.self) {
    return perSeat
      ? t(
          'auto.components.cloudWorkspaces.errorSeatLimitSelf',
          'You already have {{value0}} sandboxes running, the most one seat can run. Put one to sleep or delete it, then try again.',
          { value0: String(perSeat) }
        )
      : t(
          'auto.components.cloudWorkspaces.errorMemberConcurrencyLimit',
          "You're at your limit of running sandboxes. Put one to sleep or delete it, then try again."
        )
  }
  const name =
    owner.name ?? t('auto.components.cloudWorkspaces.seatOwnerFallback', 'The workspace owner')
  return perSeat
    ? t(
        'auto.components.cloudWorkspaces.errorSeatLimitOwner',
        '{{value0}} already has {{value1}} sandboxes running. This workspace runs on their seat, so ask them to put one to sleep, then try again.',
        { value0: name, value1: String(perSeat) }
      )
    : t(
        'auto.components.cloudWorkspaces.errorSeatLimitOwnerNoCount',
        '{{value0}} is at their limit of running sandboxes. This workspace runs on their seat, so ask them to put one to sleep, then try again.',
        { value0: name }
      )
}
