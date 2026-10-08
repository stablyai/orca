import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

export type UsageProvider = ProviderRateLimits['provider']

/** Brand-ish starting points; users override any of them in Appearance settings. */
export const DEFAULT_PROVIDER_COLORS: Record<UsageProvider, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  gemini: '#4285f4',
  antigravity: '#4285f4',
  'opencode-go': '#969696',
  kimi: '#785ae6',
  minimax: '#e6466e',
  grok: '#8c8c8c',
  cursor: '#6b6b6b',
  zcode: '#2f80ed'
}

// Why: a tint, not a fill, so usage text keeps contrast in light and dark themes.
const PROVIDER_TINT_PERCENT = 28

export function resolveProviderTint(
  settings: Pick<
    GlobalSettings,
    'statusBarProviderColorsEnabled' | 'statusBarProviderColors'
  > | null,
  provider: UsageProvider
): string | undefined {
  if (settings?.statusBarProviderColorsEnabled !== true) {
    return undefined
  }
  const color =
    settings.statusBarProviderColors?.[provider]?.trim() || DEFAULT_PROVIDER_COLORS[provider]
  return `color-mix(in srgb, ${color} ${PROVIDER_TINT_PERCENT}%, transparent)`
}
