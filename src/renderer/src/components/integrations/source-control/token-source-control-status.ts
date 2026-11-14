import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AzureDevOpsStatus, BitbucketStatus, GiteaStatus } from './integrations-pane-status'

/** Unavailable means the runtime cannot report provider status. */
export type TokenProviderStatus = BitbucketStatus | AzureDevOpsStatus | GiteaStatus | 'unavailable'

const NS = 'auto.components.settings.token.source.control.integration.cards'

/** Token providers share status labels. */
export function tokenProviderStatusLabel(
  input: {
    configured: boolean
    hasAccount?: boolean
    status: TokenProviderStatus
    /** Gitea works read-only without a token, so its unconfigured state is softer. */
    optional?: boolean
  },
  t: Translate = translate
): string {
  if (input.configured) {
    return input.hasAccount === false
      ? t(`${NS}.statusConfigured`, 'Configured')
      : t(`${NS}.statusConnected`, 'Connected')
  }
  if (input.status === 'unavailable') {
    return t(`${NS}.statusUnavailable`, 'Unavailable')
  }
  if (input.status === 'not-configured') {
    return input.optional
      ? t(`${NS}.statusOptionalSetup`, 'Optional setup')
      : t(`${NS}.statusNotConfigured`, 'Not configured')
  }
  return t(`${NS}.statusAuthFailed`, 'Auth failed')
}
