import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../shared/types'

export type UsageProviderSettings = Pick<
  GlobalSettings,
  | 'codexManagedAccounts'
  | 'claudeManagedAccounts'
  | 'opencodeSessionCookie'
  | 'geminiCliOAuthEnabled'
> & {
  // Why: Antigravity has no separate persisted usage credential in Orca. The
  // checked status-bar item is the durable user signal; StatusBar only sets
  // this after PATH detection says the agent is available. Durability further
  // requires geminiCliOAuthEnabled — the snapshot mirrors the Gemini fetch,
  // which never yields data while that opt-in is off.
  antigravityUsageConfigured: boolean
  // Why: MiniMax/Grok sign-in live on disk, not in settings; main sets these each poll.
  minimaxCookieConfigured: boolean
  grokAuthConfigured: boolean
}

type UsageProviderSnapshots = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
  kimi: ProviderRateLimits | null
  antigravity: ProviderRateLimits | null
  minimax: ProviderRateLimits | null
  grok: ProviderRateLimits | null
}

type UsageProviderId = ProviderRateLimits['provider']

function hasUsageData(provider: ProviderRateLimits): boolean {
  return Boolean(
    provider.session ||
    provider.weekly ||
    provider.fableWeekly ||
    provider.monthly ||
    (provider.buckets && provider.buckets.length > 0)
  )
}

function isProviderSnapshotPending(provider: ProviderRateLimits | null): boolean {
  return provider === null || (provider.status === 'fetching' && !hasUsageData(provider))
}

// Why: a provider that returns `unavailable` is explicitly not configured
// (Gemini OAuth off, OpenCode Go cookie unset, Claude on API-key billing). Its
// fetch object is non-null, so a bare `!== null` check still renders a "--"
// bar for a provider the user never set up. `error` is kept visible on purpose
// — that's a *configured* provider failing transiently, and hiding it would
// make the bar flap on every refresh hiccup.
export function isProviderConfigured(
  provider: ProviderRateLimits | null
): provider is ProviderRateLimits {
  if (provider === null || provider.status === 'unavailable') {
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
    settings?.geminiCliOAuthEnabled === true ||
    Boolean(settings?.opencodeSessionCookie?.trim()) ||
    // Antigravity's durable signal requires geminiCliOAuthEnabled, so it is
    // already covered by the gemini term above.
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
  if (providerId === 'gemini') {
    return settings.geminiCliOAuthEnabled === true
  }
  if (providerId === 'opencode-go') {
    return Boolean(settings.opencodeSessionCookie?.trim())
  }
  if (providerId === 'antigravity') {
    // Why: the Antigravity snapshot mirrors the Gemini fetch, which stays
    // 'unavailable' until the user opts into Gemini CLI OAuth. Without that
    // gate the default-on checked item would pin a permanently dead bar.
    return settings.antigravityUsageConfigured === true && settings.geminiCliOAuthEnabled === true
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
    ...(providerId === 'gemini' ? { buckets: [] } : {}),
    updatedAt: 0,
    error: null,
    status: 'fetching'
  }
}

export function getVisibleUsageProvider(
  providerId: UsageProviderId,
  provider: ProviderRateLimits | null,
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
  const antigravitySnapshotPending =
    hasUsageProviderSettingsForProvider('antigravity', settings) &&
    isProviderSnapshotPending(providers.antigravity)
  if (
    isProviderSnapshotPending(providers.claude) ||
    isProviderSnapshotPending(providers.codex) ||
    isProviderSnapshotPending(providers.gemini) ||
    isProviderSnapshotPending(providers.opencodeGo) ||
    isProviderSnapshotPending(providers.kimi) ||
    antigravitySnapshotPending ||
    isProviderSnapshotPending(providers.minimax) ||
    isProviderSnapshotPending(providers.grok)
  ) {
    return false
  }
  return (
    !hasUsageProviderSettings(settings) &&
    !isProviderConfigured(providers.claude) &&
    !isProviderConfigured(providers.codex) &&
    !isProviderConfigured(providers.gemini) &&
    !isProviderConfigured(providers.opencodeGo) &&
    !isProviderConfigured(providers.kimi) &&
    !isProviderConfigured(providers.antigravity) &&
    !isProviderConfigured(providers.minimax) &&
    !isProviderConfigured(providers.grok)
  )
}
