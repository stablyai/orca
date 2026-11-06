import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import { getVisibleUsageProvider, isUsageEmptyState } from './status-bar-provider-visibility'
import { isOwnerNotSetUpPlaceholder } from './owner-usage-rate-limits'

export type UsageRosterProvidersInput = {
  rateLimits: RateLimitState
  remoteOwned: boolean
  settings: GlobalSettings | null
  statusBarItems: readonly StatusBarItem[]
  /** Null when the shown usage belongs to a remote host, whose PATH this viewer cannot see. */
  detectedAgentIds: TuiAgent[] | null
}

export type UsageRosterProviders = {
  rosterProviders: ProviderRateLimits[]
  hasVisibleUsageMeters: boolean
  isEmptyUsageState: boolean
  anyFetching: boolean
}

/** Shared by the status bar and Home so both list exactly the same usage providers. */
export function deriveUsageRosterProviders({
  rateLimits,
  remoteOwned,
  settings,
  statusBarItems,
  detectedAgentIds
}: UsageRosterProvidersInput): UsageRosterProviders {
  const { claude, codex, gemini, opencodeGo, kimi, antigravity, minimax, grok, cursor, zcode } =
    rateLimits

  // Antigravity has no saved credential; the checked item and detected CLI establish setup.
  const antigravityUsageConfigured =
    !remoteOwned &&
    statusBarItems.includes('antigravity') &&
    isStatusBarItemAvailable('antigravity', detectedAgentIds)
  // Use owner-specific durable setup flags; viewer credentials cannot establish remote configuration.
  const usageSettings = {
    ...(remoteOwned ? {} : settings),
    antigravityUsageConfigured,
    minimaxCookieConfigured: rateLimits.minimaxCookieConfigured,
    minimaxApiKeyConfigured: rateLimits.minimaxApiKeyConfigured,
    opencodeGoApiKeyConfigured: rateLimits.opencodeGoApiKeyConfigured,
    grokAuthConfigured: rateLimits.grokAuthConfigured,
    cursorAuthConfigured: rateLimits.cursorAuthConfigured,
    zcodePlanApiKeyConfigured: rateLimits.zcodePlanApiKeyConfigured
  }
  const visibleClaude = getVisibleUsageProvider('claude', claude, usageSettings)
  const visibleCodex = getVisibleUsageProvider('codex', codex, usageSettings)
  const visibleGemini = getVisibleUsageProvider('gemini', gemini, usageSettings)
  const visibleKimi = getVisibleUsageProvider('kimi', kimi, usageSettings)
  const visibleAntigravity = getVisibleUsageProvider('antigravity', antigravity, usageSettings)
  const visibleMiniMax = getVisibleUsageProvider('minimax', minimax, usageSettings)
  const visibleGrok = getVisibleUsageProvider('grok', grok, usageSettings)
  const visibleCursor = getVisibleUsageProvider('cursor', cursor, usageSettings)
  const visibleZcode = getVisibleUsageProvider('zcode', zcode, usageSettings)
  const showClaude =
    visibleClaude !== null &&
    statusBarItems.includes('claude') &&
    isStatusBarItemAvailable('claude', detectedAgentIds)
  const showCodex =
    visibleCodex !== null &&
    statusBarItems.includes('codex') &&
    isStatusBarItemAvailable('codex', detectedAgentIds)
  const showGemini =
    visibleGemini !== null &&
    statusBarItems.includes('gemini') &&
    isStatusBarItemAvailable('gemini', detectedAgentIds)
  const showKimi =
    visibleKimi !== null &&
    statusBarItems.includes('kimi') &&
    isStatusBarItemAvailable('kimi', detectedAgentIds)
  const showAntigravity =
    visibleAntigravity !== null &&
    statusBarItems.includes('antigravity') &&
    isStatusBarItemAvailable('antigravity', detectedAgentIds)
  // MiniMax supports cookie/API-key usage without an installed CLI.
  const showMiniMax = visibleMiniMax !== null && statusBarItems.includes('minimax')
  const showGrok =
    visibleGrok !== null &&
    statusBarItems.includes('grok') &&
    isStatusBarItemAvailable('grok', detectedAgentIds)
  // Cursor IDE sessions can supply usage without cursor-agent on PATH.
  const showCursor = visibleCursor !== null && statusBarItems.includes('cursor')
  // A saved ZCode Coding Plan key establishes usage independently of CLI detection.
  const showZcode =
    visibleZcode !== null &&
    statusBarItems.includes('zcode') &&
    (rateLimits.zcodePlanApiKeyConfigured || isStatusBarItemAvailable('zcode', detectedAgentIds))
  // OpenCode Go usage can use web credentials independently of CLI detection.
  const visibleOpencodeGo = getVisibleUsageProvider('opencode-go', opencodeGo, usageSettings)
  const showOpencodeGo = visibleOpencodeGo !== null && statusBarItems.includes('opencode-go')
  // Why: meter-only children (excludes resource-usage) so the % display callout anchors to a real meter cluster.
  const hasVisibleUsageMeters =
    showClaude ||
    showCodex ||
    showGemini ||
    showOpencodeGo ||
    showKimi ||
    showAntigravity ||
    showMiniMax ||
    showGrok ||
    showCursor ||
    showZcode
  // Why: include Settings so durable managed accounts count — a configured user isn't shown the empty state while snapshots hydrate.
  const isEmptyUsageState = isUsageEmptyState(
    { claude, codex, gemini, opencodeGo, kimi, antigravity, minimax, grok, cursor, zcode },
    usageSettings
  )
  // Why: one-time nudge — once dismissed, stays hidden even if providers reconnect later.
  const anyFetching =
    claude?.status === 'fetching' ||
    codex?.status === 'fetching' ||
    gemini?.status === 'fetching' ||
    opencodeGo?.status === 'fetching' ||
    kimi?.status === 'fetching' ||
    antigravity?.status === 'fetching' ||
    minimax?.status === 'fetching' ||
    grok?.status === 'fetching' ||
    cursor?.status === 'fetching' ||
    zcode?.status === 'fetching'
  // Respect per-item visibility in the roster so its trigger cannot bypass hidden status items.
  const rosterProviders = [
    showClaude ? visibleClaude : null,
    showCodex ? visibleCodex : null,
    showGemini ? visibleGemini : null,
    showAntigravity ? visibleAntigravity : null,
    showOpencodeGo ? visibleOpencodeGo : null,
    showKimi ? visibleKimi : null,
    showMiniMax ? visibleMiniMax : null,
    showGrok ? visibleGrok : null,
    showCursor ? visibleCursor : null,
    showZcode ? visibleZcode : null
  ]
    .filter((p): p is ProviderRateLimits => p !== null)
    // Why: the bar collapses chips from the end, so placeholders give way first.
    .sort((a, b) => Number(isOwnerNotSetUpPlaceholder(a)) - Number(isOwnerNotSetUpPlaceholder(b)))

  return { rosterProviders, hasVisibleUsageMeters, isEmptyUsageState, anyFetching }
}
