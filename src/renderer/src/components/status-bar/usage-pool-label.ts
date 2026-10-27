import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from '@/lib/window-label-formatter'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'
import { USAGE_URGENT_PERCENT } from './provider-extra-usage-section'

export type GroupedUsagePool = RateLimitBucket & { group: string }

const WEEKLY_WINDOW_MINUTES = 10_080

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

export function formatPoolGroupLabel(group: string, buckets: readonly RateLimitBucket[]): string {
  const short = shortenGroup(group)
  const collides = buckets.some(
    (other) =>
      other.group &&
      other.group !== group &&
      (other.group === short || shortenGroup(other.group) === short)
  )
  return collides ? group : short
}

function formatPoolWindowName(bucket: RateLimitBucket): string {
  // An unmapped agy window has no length; formatWindowLabel(0) would invent "0m".
  if (!(bucket.windowMinutes > 0)) {
    return (bucket.windowName ?? '').replace(/\s*limit remaining$/i, '').trim()
  }
  if (bucket.windowMinutes === WEEKLY_WINDOW_MINUTES) {
    return translate('auto.components.status.bar.StatusBar.5c938d39ac', 'wk')
  }
  return formatWindowLabel(bucket.windowMinutes)
}

export function formatPoolWindowLabel(bucket: RateLimitBucket, now?: number): string {
  const label = formatPoolWindowName(bucket)
  // Urgency follows consumption even when the user displays the percentage remaining.
  if (clampUsedPercent(bucket.usedPercent) >= USAGE_URGENT_PERCENT && bucket.resetsAt != null) {
    const countdown = formatRateLimitWindowChipLabel(bucket, now)
    return label ? `${label} (${countdown})` : countdown
  }
  return label
}

export function formatPoolShortLabel(
  bucket: RateLimitBucket,
  buckets: readonly RateLimitBucket[],
  now?: number
): string {
  if (!bucket.group) {
    return bucket.name
  }
  return `${formatPoolGroupLabel(bucket.group, buckets)} ${formatPoolWindowLabel(bucket, now)}`.trim()
}

export function formatStatusBarSectionLabel(
  p: ProviderRateLimits,
  section: { label: string; window: RateLimitWindow },
  now?: number
): string {
  return isGroupedUsagePool(section.window)
    ? formatPoolShortLabel(section.window, p.buckets ?? [], now)
    : section.label
}
