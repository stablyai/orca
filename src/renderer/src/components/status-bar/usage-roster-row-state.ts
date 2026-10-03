import { translate } from '@/i18n/i18n'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { isCodexAuthError } from '../../../../shared/codex-auth-errors'
import { getProviderUsageStatusLabel } from './usage-error-copy'

export type UsageRosterRowState = {
  kind: 'usage' | 'loading' | 'sign-in' | 'unavailable' | 'error' | 'empty'
  statusLabel: string | null
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
  // Why: credential refresh and network failures can mention auth while live
  // sessions remain valid; only explicit signed-out copy earns a sign-in CTA.
  if (provider.usageMetadata?.failureKind) {
    return false
  }
  // Why: Codex account/rateLimits/read reports a dead ChatGPT login as an error
  // string and no failureKind. That is a sign-in, not a generic refresh failure.
  if (provider.provider === 'codex' && isCodexAuthError(provider.error)) {
    return true
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

export type InactiveAccountUsagePreview =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'usage'; limits: ProviderRateLimits }
  | { kind: 'sign-in'; label: string; limits: ProviderRateLimits }
  | { kind: 'message'; label: string }

function inactiveAccountHasWindows(limits: ProviderRateLimits): boolean {
  return Boolean(
    limits.session ||
    limits.weekly ||
    limits.fableWeekly ||
    limits.monthly ||
    (limits.buckets && limits.buckets.length > 0)
  )
}

export function previewAccountRowUsage(input: {
  active: boolean
  activeLimits: ProviderRateLimits | null | undefined
  inactive: { isFetching: boolean; rateLimits: ProviderRateLimits | null } | null | undefined
}): InactiveAccountUsagePreview {
  // Why: the header already has this login's session/weekly/Fable windows.
  // iOS paints them on the active row, including system default while that
  // row is the selection. Other rows keep their own cached read.
  if (input.active) {
    if (!input.activeLimits) {
      return { kind: 'empty' }
    }
    return previewInactiveAccountUsage({
      isFetching: input.activeLimits.status === 'fetching',
      rateLimits: input.activeLimits
    })
  }
  return previewInactiveAccountUsage(input.inactive)
}

export function previewInactiveAccountUsage(
  entry: { isFetching: boolean; rateLimits: ProviderRateLimits | null } | null | undefined
): InactiveAccountUsagePreview {
  if (!entry) {
    return { kind: 'empty' }
  }
  if (entry.isFetching && !entry.rateLimits) {
    return { kind: 'loading' }
  }
  const limits = entry.rateLimits
  if (!limits) {
    return { kind: 'empty' }
  }
  const state = getUsageRosterRowState(limits, inactiveAccountHasWindows(limits))
  if (state.kind === 'usage') {
    return { kind: 'usage', limits }
  }
  if (state.kind === 'sign-in') {
    return { kind: 'sign-in', label: state.statusLabel ?? '', limits }
  }
  if (state.statusLabel) {
    return { kind: 'message', label: state.statusLabel }
  }
  return { kind: 'empty' }
}
