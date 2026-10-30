import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

export type UsageProviderSettings = Pick<
  GlobalSettings,
  | 'codexManagedAccounts'
  | 'claudeManagedAccounts'
  | 'opencodeSessionCookie'
  | 'geminiCliOAuthEnabled'
> & {
  // Antigravity setup is a checked item plus PATH detection; agy usage needs no Gemini OAuth.
  antigravityUsageConfigured: boolean
  // Why: MiniMax/Grok sign-in live on disk, not in settings; main sets these each poll.
  minimaxCookieConfigured: boolean
  minimaxApiKeyConfigured: boolean
  // Main reports safeStorage plan-key presence so ZCode survives reload before the first poll.
  zcodePlanApiKeyConfigured: boolean
  // Main reports OpenCode key presence because the renderer cannot inspect its environment or CLI store.
  opencodeGoApiKeyConfigured: boolean
  grokAuthConfigured: boolean
  cursorAuthConfigured: boolean
}

type UsageProviderSnapshots = {
  claude: ProviderRateLimits | null | undefined
  codex: ProviderRateLimits | null | undefined
  gemini: ProviderRateLimits | null | undefined
  opencodeGo: ProviderRateLimits | null | undefined
  kimi: ProviderRateLimits | null | undefined
  antigravity: ProviderRateLimits | null | undefined
  minimax: ProviderRateLimits | null | undefined
  grok: ProviderRateLimits | null | undefined
  cursor: ProviderRateLimits | null | undefined
  zcode?: ProviderRateLimits | null
}

type UsageProviderId = ProviderRateLimits['provider']

export function hasUsageData(provider: ProviderRateLimits): boolean {
  return Boolean(
    provider.session ||
    provider.weekly ||
    provider.fableWeekly ||
    provider.monthly ||
    (provider.buckets && provider.buckets.length > 0)
  )
}

function isProviderSnapshotPending(provider: ProviderRateLimits | null | undefined): boolean {
  return provider == null || (provider.status === 'fetching' && !hasUsageData(provider))
}

// Hide unavailable/unproven snapshots; retain configured providers through transient errors to avoid flicker.
export function isProviderConfigured(
  provider: ProviderRateLimits | null | undefined
): provider is ProviderRateLimits {
  // Older main processes may omit newer provider keys during HMR.
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
    settings?.geminiCliOAuthEnabled === true ||
    Boolean(settings?.opencodeSessionCookie?.trim()) ||
    settings?.opencodeGoApiKeyConfigured === true ||
    settings?.antigravityUsageConfigured === true ||
    settings?.minimaxCookieConfigured === true ||
    settings?.minimaxApiKeyConfigured === true ||
    settings?.grokAuthConfigured === true ||
    settings?.cursorAuthConfigured === true ||
    settings?.zcodePlanApiKeyConfigured === true
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
    return (
      Boolean(settings.opencodeSessionCookie?.trim()) ||
      settings.opencodeGoApiKeyConfigured === true
    )
  }
  if (providerId === 'antigravity') {
    // The agy probe needs only the PATH-gated checked item, independent of Gemini OAuth.
    return settings.antigravityUsageConfigured === true
  }
  if (providerId === 'minimax') {
    return settings.minimaxCookieConfigured === true || settings.minimaxApiKeyConfigured === true
  }
  if (providerId === 'grok') {
    return settings.grokAuthConfigured === true
  }
  if (providerId === 'cursor') {
    return settings.cursorAuthConfigured === true
  }
  if (providerId === 'zcode') {
    return settings.zcodePlanApiKeyConfigured === true
  }
  return false
}

export function createPendingProviderSnapshot(providerId: UsageProviderId): ProviderRateLimits {
  return {
    provider: providerId,
    session: null,
    weekly: null,
    ...(providerId === 'opencode-go' ? { monthly: null } : {}),
    // Bucket-backed providers need bucket-shaped pending skeletons to avoid layout changes on their first reading.
    ...(providerId === 'gemini' || providerId === 'cursor' || providerId === 'antigravity'
      ? { buckets: [] }
      : {}),
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
  // Wait for settings hydration before offering setup that could contradict saved accounts.
  if (!settings) {
    return false
  }
  // System-default Claude/Codex have no saved account row; wait for snapshots before proposing setup.
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
    isProviderSnapshotPending(providers.grok) ||
    isProviderSnapshotPending(providers.cursor) ||
    (providers.zcode !== undefined && isProviderSnapshotPending(providers.zcode))
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
    !isProviderConfigured(providers.grok) &&
    !isProviderConfigured(providers.cursor) &&
    !isProviderConfigured(providers.zcode)
  )
}
