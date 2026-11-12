// Copy for control-plane error codes from the team workspace registry.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { signInAgainMessage } from '@/lib/orca-cloud/orca-sign-in-again'
import { getLastBillingStatus } from '@/components/billing/billing-summary-store'
import { sandboxLimitFromBilling } from '@/components/worktree-creation/vm-build-sandbox-limit'
import { classifyEntitlementDenial } from '../../../../shared/orca-billing'

/**
 * Whose seat a start counts against. The per-seat running cap counts the workspace owner's seat,
 * not the seat of whoever wakes or opens it (control plane `requireStart(row.user_id)`).
 */
export type CloudWorkspaceSeatOwner = { self: boolean; name: string | null }

// Codes describeError() has specific copy for; anything else from a 5xx is an unknown server failure.
const DESCRIBED_CODES: ReadonlySet<string> = new Set([
  'not_found',
  'entitlement_denied',
  'forbidden',
  'conflict',
  'timeout',
  'unavailable',
  'provider_unavailable',
  'unauthorized'
])

/** A 5xx with no specific copy: a failed wake reads "Couldn't wake the sandbox. Your files are safe." */
export function isUnknownServerFailure(error: string, status?: number): boolean {
  return status !== undefined && status >= 500 && !DESCRIBED_CODES.has(error)
}

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
    const denial = classifyEntitlementDenial(reason)
    if (denial === 'teamLimit') {
      const limit = sandboxLimitFromBilling(getLastBillingStatus())
      if (limit?.trial) {
        return t(
          'auto.components.cloudWorkspaces.errorTrialSandboxLimit',
          'Your trial can run {{count}} sandboxes at once. Put one to sleep or delete it, then try again.',
          {
            count: limit.team,
            defaultValue_one:
              'Your trial can run {{count}} sandbox at once. Put it to sleep or delete it, then try again.'
          }
        )
      }
      if (limit && limit.perSeat === null) {
        return t(
          'auto.components.cloudWorkspaces.errorTeamSandboxLimitNoSeat',
          'Your team can run {{count}} sandboxes at once. Put one to sleep or delete it, then try again.',
          {
            count: limit.team,
            defaultValue_one:
              'Your team can run {{count}} sandbox at once. Put it to sleep or delete it, then try again.'
          }
        )
      }
      return limit
        ? t(
            'auto.components.cloudWorkspaces.errorTeamSandboxLimit',
            'Your team can run {{count}} sandboxes at once ({{perSeat}} per seat). Put one to sleep or delete it, then try again.',
            {
              count: limit.team,
              perSeat: String(limit.perSeat),
              defaultValue_one:
                'Your team can run {{count}} sandbox at once ({{perSeat}} per seat). Put it to sleep or delete it, then try again.'
            }
          )
        : t(
            'auto.components.cloudWorkspaces.errorConcurrencyLimit',
            "You're at your team's limit of running sandboxes. Put one to sleep or delete it, then try again."
          )
    }
    if (denial === 'memberLimit') {
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
    return signInAgainMessage(t)
  }
  return t(
    'auto.components.cloudWorkspaces.errorUnknown',
    'Something went wrong. Nothing was changed. Try again.'
  )
}

/**
 * The same messages for an inline error that already carries the action button (Retry or Sign
 * in), so the body does not repeat "Try again.". An expired session keeps the one shared
 * sign-in sentence so every surface says the same thing.
 */
export function describeInlineError(
  error: string,
  reason?: string,
  t: Translate = translate
): string {
  if (error === 'unauthorized') {
    return signInAgainMessage(t)
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
  const limit = sandboxLimitFromBilling(getLastBillingStatus())
  if (limit?.trial) {
    return t(
      'auto.components.cloudWorkspaces.errorTrialSandboxLimit',
      'Your trial can run {{count}} sandboxes at once. Put one to sleep or delete it, then try again.',
      {
        count: limit.team,
        defaultValue_one:
          'Your trial can run {{count}} sandbox at once. Put it to sleep or delete it, then try again.'
      }
    )
  }
  const perSeat = limit?.perMember
  if (!owner || owner.self) {
    return perSeat
      ? t(
          'auto.components.cloudWorkspaces.errorSeatSandboxLimitSelf',
          'You already have {{count}} sandboxes running, the most one seat can run. Put one to sleep or delete it, then try again.',
          {
            count: perSeat,
            defaultValue_one:
              'You already have {{count}} sandbox running, the most one seat can run. Put it to sleep or delete it, then try again.'
          }
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
        'auto.components.cloudWorkspaces.errorSeatSandboxLimitOwner',
        '{{name}} already has {{count}} sandboxes running. This workspace runs on their seat, so ask them to put one to sleep, then try again.',
        {
          name,
          count: perSeat,
          defaultValue_one:
            '{{name}} already has {{count}} sandbox running. This workspace runs on their seat, so ask them to put it to sleep, then try again.'
        }
      )
    : t(
        'auto.components.cloudWorkspaces.errorSeatLimitOwnerNoCount',
        '{{value0}} is at their limit of running sandboxes. This workspace runs on their seat, so ask them to put one to sleep, then try again.',
        { value0: name }
      )
}
