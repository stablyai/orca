import type { ProviderRateLimits } from './rate-limit-types'

export type UsageRequestProvider = ProviderRateLimits['provider']
export type UsageRequestEnabled = Partial<
  Record<Exclude<UsageRequestProvider, 'antigravity'>, boolean>
>
export type UsageRequestSettings = { usageRequestEnabled?: UsageRequestEnabled }
export type UsageRequestPolicy = {
  version: 1
  revision: number
  enabled: Record<UsageRequestProvider, boolean>
}

export const USAGE_REQUEST_PROVIDERS = [
  'claude',
  'codex',
  'gemini',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'antigravity',
  'cursor',
  'zcode'
] as const satisfies readonly UsageRequestProvider[]

type UsageRequestPolicyInput = Record<string, unknown>

function isUsageRequestPolicyInput(value: unknown): value is UsageRequestPolicyInput {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeUsageRequestEnabled(value: unknown): UsageRequestEnabled {
  const normalized: UsageRequestEnabled = {}
  if (!isUsageRequestPolicyInput(value)) {
    return normalized
  }
  for (const provider of USAGE_REQUEST_PROVIDERS) {
    if (provider === 'antigravity' || !Object.hasOwn(value, provider)) {
      continue
    }
    const enabled = value[provider]
    if (typeof enabled === 'boolean') {
      normalized[provider] = enabled
    }
  }
  return normalized
}

export function mergeUsageRequestEnabled(current: unknown, updates: unknown): UsageRequestEnabled {
  return { ...normalizeUsageRequestEnabled(current), ...normalizeUsageRequestEnabled(updates) }
}

export function composeUsageRequestPolicyEnabled(
  value: unknown,
  antigravityEnabled: boolean
): Record<UsageRequestProvider, boolean> {
  const sparse = normalizeUsageRequestEnabled(value)
  return {
    claude: sparse.claude !== false,
    codex: sparse.codex !== false,
    gemini: sparse.gemini !== false,
    'opencode-go': sparse['opencode-go'] !== false,
    kimi: sparse.kimi !== false,
    minimax: sparse.minimax !== false,
    grok: sparse.grok !== false,
    antigravity: antigravityEnabled,
    cursor: sparse.cursor !== false,
    zcode: sparse.zcode !== false
  }
}
