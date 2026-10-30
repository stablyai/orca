import { translate } from '@/i18n/i18n'
import type { AzureDevOpsStatus, BitbucketStatus, GiteaStatus } from './integrations-pane-status'

/** Unavailable means the runtime cannot report provider status. */
export type TokenProviderStatus = BitbucketStatus | AzureDevOpsStatus | GiteaStatus | 'unavailable'

const NS = 'auto.components.settings.token.source.control.integration.cards'

/** Token providers share status labels. */
export function tokenProviderStatusLabel(input: {
  configured: boolean
  hasAccount?: boolean
  status: TokenProviderStatus
  /** Gitea works read-only without a token, so its unconfigured state is softer. */
  optional?: boolean
}): string {
  if (input.configured) {
    return input.hasAccount === false
      ? translate(`${NS}.statusConfigured`, 'Configured')
      : translate(`${NS}.statusConnected`, 'Connected')
  }
  if (input.status === 'unavailable') {
    return translate(`${NS}.statusUnavailable`, 'Unavailable')
  }
  if (input.status === 'not-configured') {
    return input.optional
      ? translate(`${NS}.statusOptionalSetup`, 'Optional setup')
      : translate(`${NS}.statusNotConfigured`, 'Not configured')
  }
  return translate(`${NS}.statusAuthFailed`, 'Auth failed')
}
