import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { UsageCredentialsHostOutdatedError } from '@/runtime/provider-accounts/usage/runtime-usage-credentials-client'

/** Save keys on the host whose usage poller reads them. */
export type UsageCredentialHost = {
  owner: RuntimeClientTarget
  /** Null for this computer. */
  label: string | null
}

export const LOCAL_USAGE_CREDENTIAL_HOST: UsageCredentialHost = {
  owner: { kind: 'local' },
  label: null
}

/** `unreachable` is unverifiable, not "no key": the host may well hold one. */
export type UsageCredentialAccess = 'checking' | 'ready' | 'outdated' | 'unreachable'

export function usageCredentialAccessAfterError(error: unknown): 'outdated' | 'unreachable' {
  return error instanceof UsageCredentialsHostOutdatedError ? 'outdated' : 'unreachable'
}

export function usageCredentialAccessNotice(
  host: UsageCredentialHost,
  access: UsageCredentialAccess,
  t: Translate = translate
): string | null {
  if (host.label === null) {
    return null
  }
  if (access === 'checking') {
    return t('auto.components.settings.usageCredentialHost.checking', 'Checking {{host}}…', {
      host: host.label
    })
  }
  if (access === 'outdated') {
    return t(
      'auto.components.settings.usageCredentialHost.outdated',
      'Update Orca on {{host}} to save this key there.',
      { host: host.label }
    )
  }
  if (access === 'unreachable') {
    return t(
      'auto.components.settings.usageCredentialHost.unreachable',
      'Could not reach {{host}}, so whether a key is saved there is unknown.',
      { host: host.label }
    )
  }
  return null
}

/** A remote host's saved key it cannot use: sealed by its other Orca app, or just unreadable. */
export function usageCredentialUnreadableNotice(
  host: UsageCredentialHost,
  unreadable: 'sealed-elsewhere' | 'unreadable' | undefined,
  t: Translate = translate
): string | null {
  if (host.label === null || unreadable === undefined) {
    return null
  }
  return unreadable === 'sealed-elsewhere'
    ? t(
        'auto.components.settings.usageCredentialHost.sealedElsewhereForgettable',
        'Saved by another Orca app on {{host}}, which this one cannot read. Change it in that app, or forget it here.',
        { host: host.label }
      )
    : t(
        'auto.components.settings.usageCredentialHost.unreadableKey',
        'Orca on {{host}} cannot read the saved key. Replace it or forget it.',
        { host: host.label }
      )
}

/** Only the app that sealed a key can read and replace it. */
export function usageCredentialSealedElsewhere(
  host: UsageCredentialHost,
  unreadable: 'sealed-elsewhere' | 'unreadable' | undefined
): boolean {
  return host.label !== null && unreadable === 'sealed-elsewhere'
}

export function usageCredentialStoredLabel(
  host: UsageCredentialHost,
  t: Translate = translate
): string {
  return host.label === null
    ? t('auto.components.settings.AccountsPane.0b8c1c7e02', 'Stored locally')
    : t('auto.components.settings.usageCredentialHost.storedOnHost', 'Stored on {{host}}', {
        host: host.label
      })
}

export function zcodePlanKeyDescription(
  host: UsageCredentialHost,
  t: Translate = translate
): string {
  return host.label === null
    ? t(
        'auto.components.settings.ZcodePlanAccountsSection.keyDescription',
        'Paste the API key from the selected console’s API Keys page. Stored locally, encrypted when the OS supports it, and sent only to that site for usage refreshes.'
      )
    : t(
        'auto.components.settings.ZcodePlanAccountsSection.keyOnHostDescription',
        'Paste the API key from the selected console’s API Keys page. Stored on {{host}} and sent from there only to that site for usage refreshes.',
        { host: host.label }
      )
}
