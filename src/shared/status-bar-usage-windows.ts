import type { ProviderRateLimits } from './rate-limit-types'

export type UsageProviderId = ProviderRateLimits['provider']

/** A window the user pinned to the status bar; buckets are keyed by the name the provider reports. */
export type StatusBarUsageWindowKey =
  | 'session'
  | 'weekly'
  | 'fableWeekly'
  | 'monthly'
  | `bucket:${string}`

/** Absent or empty for a provider means the footer's default summary for it. */
export type StatusBarUsageWindows = Partial<Record<UsageProviderId, StatusBarUsageWindowKey[]>>

// Why a Record: adding a provider to the union fails to compile until it is listed here.
const USAGE_PROVIDER_IDS: Record<UsageProviderId, true> = {
  claude: true,
  codex: true,
  gemini: true,
  'opencode-go': true,
  kimi: true,
  minimax: true,
  grok: true,
  antigravity: true,
  cursor: true,
  zcode: true
}

const NAMED_WINDOW_KEYS = new Set(['session', 'weekly', 'fableWeekly', 'monthly'])
const MAX_WINDOWS_PER_PROVIDER = 16
const MAX_BUCKET_NAME_LENGTH = 200

export function bucketWindowKey(bucketName: string): StatusBarUsageWindowKey {
  return `bucket:${bucketName}`
}

function isUsageProviderId(value: string): value is UsageProviderId {
  return Object.hasOwn(USAGE_PROVIDER_IDS, value)
}

function isStatusBarUsageWindowKey(value: unknown): value is StatusBarUsageWindowKey {
  if (typeof value !== 'string') {
    return false
  }
  if (NAMED_WINDOW_KEYS.has(value)) {
    return true
  }
  const bucketName = value.startsWith('bucket:') ? value.slice('bucket:'.length) : ''
  return bucketName.length > 0 && bucketName.length <= MAX_BUCKET_NAME_LENGTH
}

export function normalizeStatusBarUsageWindowKeys(value: unknown): StatusBarUsageWindowKey[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter(isStatusBarUsageWindowKey))].slice(0, MAX_WINDOWS_PER_PROVIDER)
}

export function normalizeStatusBarUsageWindows(value: unknown): StatusBarUsageWindows {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const result: StatusBarUsageWindows = {}
  for (const [provider, keys] of Object.entries(value)) {
    const normalized = normalizeStatusBarUsageWindowKeys(keys)
    if (isUsageProviderId(provider) && normalized.length > 0) {
      result[provider] = normalized
    }
  }
  return result
}

/** Returns a new map; an empty pick list restores the provider's default summary. */
export function withStatusBarUsageWindows(
  current: StatusBarUsageWindows,
  provider: UsageProviderId,
  keys: readonly StatusBarUsageWindowKey[]
): StatusBarUsageWindows {
  const { [provider]: _previous, ...rest } = current
  const normalized = normalizeStatusBarUsageWindowKeys(keys)
  return normalized.length > 0 ? { ...rest, [provider]: normalized } : rest
}
