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
          'Your team is running as many cloud workspaces as its plan allows.'
        )
      : t(
          'auto.components.cloudWorkspaces.errorEntitlementDenied',
          'Your plan does not allow starting this workspace right now.'
        )
  }
  if (error === 'forbidden') {
    return t(
      'auto.components.cloudWorkspaces.errorForbidden',
      'Only the owner or an org admin can do that.'
    )
  }
  if (error === 'conflict') {
    return reason === 'too_many_devices'
      ? t(
          'auto.components.cloudWorkspaces.errorTooManyDevices',
          'Too many of your devices are paired with this workspace. Remove one first.'
        )
      : t(
          'auto.components.cloudWorkspaces.errorConflict',
          'The workspace is busy changing state. Try again in a moment.'
        )
  }
  if (error === 'timeout' || error === 'unavailable' || error === 'provider_unavailable') {
    return t(
      'auto.components.cloudWorkspaces.errorUnreachable',
      'Orca Cloud is not reachable right now. Try again.'
    )
  }
  if (error === 'unauthorized') {
    return t(
      'auto.components.cloudWorkspaces.errorUnauthorized',
      'Your Orca Cloud session expired. Sign in again.'
    )
  }
  return t('auto.components.cloudWorkspaces.errorUnknown', 'Something went wrong. Try again.')
}
