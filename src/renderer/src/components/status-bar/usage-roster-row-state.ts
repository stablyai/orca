import { translate } from '@/i18n/i18n'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getOwnerNotSetUpLabel, getOwnerNotSetUpNote } from './owner-not-set-up-copy'
import { getProviderUsageStatusLabel } from './usage-error-copy'

export type UsageRosterRowState = {
  kind: 'usage' | 'loading' | 'sign-in' | 'unavailable' | 'error' | 'empty'
  statusLabel: string | null
  /** A second line under the row, for context the label cannot fit. */
  detail?: string | null
}

const CONFIRMED_SIGN_OUT_PATTERNS = [
  /\bnot signed in\b/i,
  /\bnot logged in\b/i,
  /\blogged out\b/i,
  /\bauthentication required\b/i,
  /\b(?:sign|log)[ -]?in required\b/i,
  /\bplease (?:sign|log) in\b/i,
  /\bplease reauthenticate\b/i
]

function isConfirmedSignedOut(provider: ProviderRateLimits): boolean {
  if (provider.usageMetadata?.failureKind === 'missing-credentials') {
    return true
  }
  // Auth wording may describe a refresh/network failure; only proven sign-out warrants a sign-in CTA.
  if (provider.usageMetadata?.failureKind) {
    return false
  }
  const error = provider.error
  return Boolean(error && CONFIRMED_SIGN_OUT_PATTERNS.some((pattern) => pattern.test(error)))
}

export function getUsageRosterRowState(
  provider: ProviderRateLimits,
  hasUsage: boolean
): UsageRosterRowState {
  if (hasUsage) {
    return { kind: 'usage', statusLabel: null }
  }
  const placeholder = provider.usageMetadata?.ownerNotSetUp
  if (placeholder) {
    return {
      kind: 'unavailable',
      statusLabel: getOwnerNotSetUpLabel(placeholder),
      detail: getOwnerNotSetUpNote(placeholder)
    }
  }
  if (provider.status === 'idle' || provider.status === 'fetching') {
    return {
      kind: 'loading',
      statusLabel: translate(
        'auto.components.status.bar.UsageRosterPanel.loadingUsage',
        'Loading usage…'
      )
    }
  }
  if (isConfirmedSignedOut(provider)) {
    return {
      kind: 'sign-in',
      statusLabel: translate(
        'auto.components.status.bar.UsageRosterPanel.notSignedIn',
        'not signed in'
      )
    }
  }
  if (provider.status === 'error') {
    return { kind: 'error', statusLabel: getProviderUsageStatusLabel(provider) }
  }
  if (provider.status === 'unavailable') {
    return {
      kind: 'unavailable',
      statusLabel: translate(
        'auto.components.status.bar.UsageRosterPanel.usageUnavailable',
        'Usage unavailable'
      )
    }
  }
  return {
    kind: 'empty',
    statusLabel: translate(
      'auto.components.status.bar.UsageRosterPanel.noUsageData',
      'No usage data'
    )
  }
}
