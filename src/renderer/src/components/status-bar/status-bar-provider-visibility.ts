import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../shared/types'

export type UsageProviderSettings = Pick<
  GlobalSettings,
  'codexManagedAccounts' | 'claudeManagedAccounts' | 'opencodeSessionCookie'
> & {
  // Why: MiniMax/Grok sign-in live on disk, not in settings; main sets these each poll.
  minimaxCookieConfigured: boolean
  grokAuthConfigured: boolean
}

type UsageProviderSnapshots = {
  claude: ProviderRateLimits | null | undefined
  codex: ProviderRateLimits | null | undefined
  opencodeGo: ProviderRateLimits | null | undefined
  kimi: ProviderRateLimits | null | undefined
  minimax: ProviderRateLimits | null | undefined
  grok: ProviderRateLimits | null | undefined
}

type UsageProviderId = ProviderRateLimits['provider']

function hasUsageData(provider: ProviderRateLimits): boolean {
  return Boolean(provider.session || provider.weekly || provider.fableWeekly || provider.monthly)
}

function isProviderSnapshotPending(provider: ProviderRateLimits | null | undefined): boolean {
  return provider == null || (provider.status === 'fetching' && !hasUsageData(provider))
}

// Why: a provider that returns `unavailable` is explicitly not configured
// (OpenCode Go cookie unset, Claude on API-key billing). Its
// fetch object is non-null, so a bare `!== null` check still renders a "--"
// bar for a provider the user never set up. `error` is kept visible on purpose
// — that's a *configured* provider failing transiently, and hiding it would
// make the bar flap on every refresh hiccup.
export function isProviderConfigured(
  provider: ProviderRateLimits | null | undefined
): provider is ProviderRateLimits {
  // Why: renderer HMR can briefly run against an older main process whose rate-limit
  // payload predates newer provider keys, so missing snapshots arrive as undefined.
  if (provider == null || provider.status === 'unavailable') {
    return false
  }
  if (provider.status === 'fetching' && !hasUsageData(provider)) {
    return false
  }
  return true
}

export function hasUsageProviderSettings(
  settings: Partial<UsageProviderSettings> | null | undefined
): boolean {
  return Boolean(
    (settings?.codexManagedAccounts?.length ?? 0) > 0 ||
    (settings?.claudeManagedAccounts?.length ?? 0) > 0 ||
    Boolean(settings?.opencodeSessionCookie?.trim()) ||
    settings?.minimaxCookieConfigured === true ||
    settings?.grokAuthConfigured === true
  )
}

export function hasUsageProviderSettingsForProvider(
  providerId: UsageProviderId,
  settings: Partial<UsageProviderSettings> | null | undefined
): boolean {
  if (!settings) {
    return false
  }
  if (providerId === 'claude') {
    return (settings.claudeManagedAccounts?.length ?? 0) > 0
  }
  if (providerId === 'codex') {
    return (settings.codexManagedAccounts?.length ?? 0) > 0
  }
  if (providerId === 'opencode-go') {
    return Boolean(settings.opencodeSessionCookie?.trim())
  }
  if (providerId === 'minimax') {
    return settings.minimaxCookieConfigured === true
  }
  if (providerId === 'grok') {
    return settings.grokAuthConfigured === true
  }
  return false
}

function createPendingProviderSnapshot(providerId: UsageProviderId): ProviderRateLimits {
  return {
    provider: providerId,
    session: null,
    weekly: null,
    ...(providerId === 'opencode-go' ? { monthly: null } : {}),
    updatedAt: 0,
    error: null,
    status: 'fetching'
  }
}

export function getVisibleUsageProvider(
  providerId: UsageProviderId,
  provider: ProviderRateLimits | null | undefined,
  settings: Partial<UsageProviderSettings> | null | undefined
): ProviderRateLimits | null {
  if (isProviderConfigured(provider)) {
    return provider
  }
  if (!hasUsageProviderSettingsForProvider(providerId, settings)) {
    return null
  }
  return provider ?? createPendingProviderSnapshot(providerId)
}

export function isUsageEmptyState(
  providers: UsageProviderSnapshots,
  settings: Partial<UsageProviderSettings> | null | undefined
): boolean {
  // Why: settings are the durable source for managed accounts. Until they
  // hydrate, avoid showing a setup CTA that can contradict connected accounts.
  if (!settings) {
    return false
  }
  // Why: system-default Claude/Codex accounts have no persisted account row;
  // their first durable signal is the usage snapshot, so wait for snapshots to
  // settle before teaching the user to connect an account.
  if (
    isProviderSnapshotPending(providers.claude) ||
    isProviderSnapshotPending(providers.codex) ||
    isProviderSnapshotPending(providers.opencodeGo) ||
    isProviderSnapshotPending(providers.kimi) ||
    isProviderSnapshotPending(providers.minimax) ||
    isProviderSnapshotPending(providers.grok)
  ) {
    return false
  }
  return (
    !hasUsageProviderSettings(settings) &&
    !isProviderConfigured(providers.claude) &&
    !isProviderConfigured(providers.codex) &&
    !isProviderConfigured(providers.opencodeGo) &&
    !isProviderConfigured(providers.kimi) &&
    !isProviderConfigured(providers.minimax) &&
    !isProviderConfigured(providers.grok)
  )
}
