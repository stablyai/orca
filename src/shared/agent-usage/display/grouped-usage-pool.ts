import type { RateLimitBucket, RateLimitWindow } from '../rate-limits/rate-limit-types'

export type GroupedUsagePool = RateLimitBucket & { group: string }

export function isGroupedUsagePool(window: RateLimitWindow): window is GroupedUsagePool {
  return (
    'name' in window &&
    typeof window.name === 'string' &&
    'group' in window &&
    typeof window.group === 'string' &&
    window.group.length > 0
  )
}

function shortenGroup(group: string): string {
  const short = group
    .replace(/\s+models$/i, '')
    .replace(/\s+and\s+/gi, '/')
    .trim()
  return short || group
}

// Structural so mobile's passthrough buckets, whose group is unknown, fit too; `name` keeps it from being a weak type.
export type UsagePoolSibling = { name: string; group?: unknown }

export function formatPoolGroupLabel(group: string, buckets: readonly UsagePoolSibling[]): string {
  const short = shortenGroup(group)
  const collides = buckets.some(
    (other) =>
      typeof other.group === 'string' &&
      other.group.length > 0 &&
      other.group !== group &&
      (other.group === short || shortenGroup(other.group) === short)
  )
  return collides ? group : short
}

// agy names windows "… Limit Remaining", which contradicts percentages shown as used.
export function stripPoolDirectionSuffix(windowName: string | null | undefined): string {
  return (windowName ?? '').replace(/\s*limit remaining$/i, '').trim()
}

export function formatPoolWindowName(
  pool: RateLimitBucket,
  formatMinutes: (minutes: number) => string
): string {
  // An unmapped agy window has no length; formatting 0 minutes would invent "0m".
  return pool.windowMinutes > 0
    ? formatMinutes(pool.windowMinutes)
    : stripPoolDirectionSuffix(pool.windowName)
}

export function formatPoolLabel(
  pool: GroupedUsagePool,
  buckets: readonly UsagePoolSibling[],
  formatMinutes: (minutes: number) => string
): string {
  const group = formatPoolGroupLabel(pool.group, buckets)
  const windowName = formatPoolWindowName(pool, formatMinutes)
  return windowName ? `${group} · ${windowName}` : group
}
