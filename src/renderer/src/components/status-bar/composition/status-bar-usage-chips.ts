import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { isOwnerNotSetUpPlaceholder } from '../usage/owner-usage-rate-limits'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import {
  getVisibleUsageProvider,
  type UsageProviderSettings
} from './status-bar-provider-visibility'

export function selectStatusBarUsageChips(args: {
  rateLimits: RateLimitState
  remoteOwned: boolean
  settings: GlobalSettings | null
  statusBarItems: readonly StatusBarItem[]
  detectedAgentIds: TuiAgent[] | null
}): {
  usageSettings: Partial<UsageProviderSettings>
  rosterProviders: ProviderRateLimits[]
  hasVisibleUsageMeters: boolean
  anyFetching: boolean
} {
  const { rateLimits, remoteOwned, settings, statusBarItems, detectedAgentIds } = args
  const { claude, codex, gemini, opencodeGo, kimi, antigravity, minimax, grok, cursor, zcode } =
    rateLimits
  const muse = rateLimits.muse
  const copilot = rateLimits.copilot
  // Antigravity has no saved credential; the checked item and detected CLI establish setup.
  const antigravityUsageConfigured =
    !remoteOwned &&
    statusBarItems.includes('antigravity') &&
    isStatusBarItemAvailable('antigravity', detectedAgentIds)
  // Viewer credentials cannot establish remote configuration.
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
  const visibleMuse = getVisibleUsageProvider('muse', muse, usageSettings)
  const visibleCopilot = getVisibleUsageProvider('copilot', copilot, usageSettings)
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
  const showMuse =
    visibleMuse !== null &&
    statusBarItems.includes('muse') &&
    isStatusBarItemAvailable('muse', detectedAgentIds)
  // Quota is read from gh, so the chip does not wait for the copilot binary.
  const showCopilot = visibleCopilot !== null && statusBarItems.includes('copilot')
  // OpenCode Go usage can use web credentials independently of CLI detection.
  const visibleOpencodeGo = getVisibleUsageProvider('opencode-go', opencodeGo, usageSettings)
  const showOpencodeGo = visibleOpencodeGo !== null && statusBarItems.includes('opencode-go')
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
    showZcode ? visibleZcode : null,
    showMuse ? visibleMuse : null,
    showCopilot ? visibleCopilot : null
  ]
    .filter((provider): provider is ProviderRateLimits => provider !== null)
    // Placeholders give way first so the bar collapses real meters last.
    .sort((a, b) => Number(isOwnerNotSetUpPlaceholder(a)) - Number(isOwnerNotSetUpPlaceholder(b)))
  return {
    usageSettings,
    rosterProviders,
    hasVisibleUsageMeters:
      showClaude ||
      showCodex ||
      showGemini ||
      showOpencodeGo ||
      showKimi ||
      showAntigravity ||
      showMiniMax ||
      showGrok ||
      showCursor ||
      showZcode ||
      showMuse ||
      showCopilot,
    anyFetching: [
      claude,
      codex,
      gemini,
      opencodeGo,
      kimi,
      antigravity,
      minimax,
      grok,
      cursor,
      zcode,
      muse,
      copilot
    ].some((provider) => provider?.status === 'fetching')
  }
}
