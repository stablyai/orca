import { translate } from '@/i18n/i18n'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'
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

export type UsageRosterEntry = {
  key: string
  limits: ProviderRateLimits
  interactive: boolean
  accountId: string | null
  title: string | null
  updatedAt: number | null
}

function windowUsedPercent(window: { usedPercent: number } | null | undefined): number {
  return window ? clampUsedPercent(window.usedPercent) : 0
}

function providerMaxUsedPercent(limits: ProviderRateLimits): number {
  const bucketMax =
    limits.buckets && limits.buckets.length > 0
      ? Math.max(...limits.buckets.map((bucket) => clampUsedPercent(bucket.usedPercent)))
      : 0
  return Math.max(
    windowUsedPercent(limits.session),
    windowUsedPercent(limits.weekly),
    windowUsedPercent(limits.fableWeekly),
    windowUsedPercent(limits.monthly),
    bucketMax
  )
}

function inactiveCodexLimits(account: InactiveAccountUsage): ProviderRateLimits {
  if (account.rateLimits) {
    return account.rateLimits
  }
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: account.updatedAt,
    error: null,
    status: account.isFetching ? 'fetching' : 'ok'
  }
}

function toInactiveCodexEntry(
  account: InactiveAccountUsage,
  title: string | null
): UsageRosterEntry {
  const limits = inactiveCodexLimits(account)
  return {
    key: `codex:${account.accountId}`,
    limits,
    interactive: false,
    accountId: account.accountId,
    title,
    updatedAt: account.updatedAt || limits.updatedAt || null
  }
}

export function buildUsageRosterEntries(
  providers: readonly ProviderRateLimits[],
  inactiveCodexAccounts: readonly InactiveAccountUsage[] = [],
  accountLabels: Readonly<Record<string, string>> = {}
): UsageRosterEntry[] {
  const sortedProviders = [...providers].sort(
    (a, b) => providerMaxUsedPercent(b) - providerMaxUsedPercent(a)
  )
  const inactiveEntries = [...inactiveCodexAccounts]
    .map((account) => toInactiveCodexEntry(account, accountLabels[account.accountId] ?? null))
    .sort((a, b) => providerMaxUsedPercent(b.limits) - providerMaxUsedPercent(a.limits))

  const entries: UsageRosterEntry[] = []
  for (const limits of sortedProviders) {
    entries.push({
      key: limits.provider,
      limits,
      interactive: true,
      accountId: null,
      title: null,
      updatedAt: null
    })
    if (limits.provider === 'codex') {
      entries.push(...inactiveEntries)
    }
  }
  return entries
}
