// Copy for control-plane error codes from the team workspace registry.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function describeError(error: string, reason?: string, t: Translate = translate): string {
  if (error === 'not_found') {
    return t(
      'auto.components.cloudWorkspaces.errorNotFound',
      'This workspace is private, archived or no longer exists.'
    )
  }
  if (error === 'entitlement_denied') {
    return reason === 'concurrency_limit'
      ? t(
          'auto.components.cloudWorkspaces.errorConcurrencyLimit',
          "You're at your team's limit of running sandboxes. Put one to sleep or delete it, then try again."
        )
      : t(
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
    return t('auto.components.cloudWorkspaces.errorUnauthorizedInline', 'Your Orca Cloud session expired.')
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
  return t('auto.components.cloudWorkspaces.errorUnknownInline', 'Something went wrong. Nothing was changed.')
}
