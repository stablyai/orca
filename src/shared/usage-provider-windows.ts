import type { ProviderRateLimits, RateLimitWindow } from './rate-limit-types'

// Structural so mobile's decoded snapshot, whose provider id is any string, fits too.
type ProviderUsageWindows = {
  provider: string
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  fableWeekly?: RateLimitWindow | null
  monthly?: RateLimitWindow | null
  buckets?: readonly (RateLimitWindow & { name: string })[]
}

export type UsageWindowSection =
  | { kind: 'bucket'; name: string; window: RateLimitWindow }
  | {
      kind: 'session' | 'weekly' | 'fableWeekly' | 'monthly' | 'plan' | 'mcp'
      window: RateLimitWindow | null
    }

// `satisfies` makes a provider added to ProviderRateLimits fail the typecheck until it has a name.
const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  'opencode-go': 'OpenCode Go',
  kimi: 'Kimi',
  antigravity: 'Antigravity',
  minimax: 'MiniMax',
  grok: 'Grok',
  zcode: 'ZCode',
  cursor: 'Cursor',
  deepseek: 'DeepSeek',
  muse: 'Muse'
} satisfies Record<ProviderRateLimits['provider'], string>

// A provider id from a newer host falls back to the id itself.
export function getProviderDisplayName(provider: string): string {
  return Object.hasOwn(PROVIDER_DISPLAY_NAMES, provider)
    ? PROVIDER_DISPLAY_NAMES[provider]
    : provider
}

export function hasUsageData(provider: ProviderUsageWindows): boolean {
  return Boolean(
    provider.session ||
    provider.weekly ||
    provider.fableWeekly ||
    provider.monthly ||
    (provider.buckets && provider.buckets.length > 0)
  )
}

/** The usage windows a provider shows, in order; session and weekly stay as null placeholders. */
export function getUsageWindowSections(p: ProviderUsageWindows): UsageWindowSection[] {
  if (p.buckets?.length) {
    return [
      ...p.buckets.map((bucket) => ({
        kind: 'bucket' as const,
        name: bucket.name,
        window: bucket
      })),
      // Include Cursor’s monthly plan total because pools can understate proximity to its cap.
      ...(p.monthly
        ? [
            {
              kind: p.provider === 'cursor' ? ('plan' as const) : ('monthly' as const),
              window: p.monthly
            }
          ]
        : []),
      { kind: 'weekly', window: p.weekly }
    ]
  }
  const sections: UsageWindowSection[] = [
    { kind: 'session', window: p.session },
    { kind: 'weekly', window: p.weekly }
  ]
  if (p.fableWeekly) {
    sections.push({ kind: 'fableWeekly', window: p.fableWeekly })
  }
  if (p.monthly) {
    sections.push({ kind: p.provider === 'zcode' ? 'mcp' : 'monthly', window: p.monthly })
  }
  return sections
}
