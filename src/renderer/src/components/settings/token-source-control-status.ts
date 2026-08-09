import { translate } from '@/i18n/i18n'
import type { AzureDevOpsStatus, BitbucketStatus, GiteaStatus } from './integrations-pane-status'

/**
 * Card status as the pane computes it: the provider's own state, or
 * `'unavailable'` when the runtime cannot report on it at all.
 */
export type TokenProviderStatus = BitbucketStatus | AzureDevOpsStatus | GiteaStatus | 'unavailable'

const NS = 'auto.components.settings.token.source.control.integration.cards'

/**
 * Status copy for the token-configured source-control cards (Bitbucket, Azure
 * DevOps, Gitea). They share the same states, so the labels live in one place.
 */
export function tokenProviderStatusLabel(input: {
  /** Credentials present for the provider. */
  configured: boolean
  /** An account was resolved with those credentials. */
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
