import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  formatRateLimitWindowChipLabel,
  formatWindowLabel
} from './rate-limit-window-localized-label'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { clampUsedPercent } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import {
  formatPoolGroupLabel,
  formatPoolLabel,
  formatPoolWindowName,
  isGroupedUsagePool,
  type GroupedUsagePool
} from '../../../../../shared/agent-usage/display/grouped-usage-pool'
import { WEEKLY_WINDOW_MINUTES } from '../../../../../shared/agent-usage/display/usage-provider-windows'
import { USAGE_WARNING_PERCENT } from './usage-health-tone'

function formatShortPoolWindowName(bucket: RateLimitBucket, t: Translate = translate): string {
  return formatPoolWindowName(bucket, (minutes) =>
    minutes === WEEKLY_WINDOW_MINUTES
      ? t('auto.components.status.bar.StatusBar.5c938d39ac', 'wk')
      : formatWindowLabel(minutes)
  )
}

export function formatPoolRosterLabel(
  bucket: GroupedUsagePool,
  buckets: readonly RateLimitBucket[],
  t: Translate = translate
): string {
  return `${formatPoolGroupLabel(bucket.group, buckets)} ${formatShortPoolWindowName(bucket, t)}`.trim()
}

export function formatPoolCardLabel(
  bucket: GroupedUsagePool,
  buckets: readonly RateLimitBucket[],
  t: Translate = translate
): string {
  return formatPoolLabel(bucket, buckets, (minutes) =>
    minutes === WEEKLY_WINDOW_MINUTES
      ? t('auto.components.status.bar.tooltip.252c096536', 'Weekly')
      : formatWindowLabel(minutes)
  )
}

export function formatPoolWindowLabel(
  bucket: RateLimitBucket,
  now?: number,
  t?: Translate
): string {
  const label = formatShortPoolWindowName(bucket, t)
  // Show the reset once the pool turns yellow, by consumption whatever the % display.
  if (clampUsedPercent(bucket.usedPercent) >= USAGE_WARNING_PERCENT && bucket.resetsAt != null) {
    const countdown = formatRateLimitWindowChipLabel(bucket, now)
    return label ? `${label} (${countdown})` : countdown
  }
  return label
}

export function formatPoolShortLabel(
  bucket: RateLimitBucket,
  buckets: readonly RateLimitBucket[],
  now?: number,
  t?: Translate
): string {
  if (!bucket.group) {
    return bucket.name
  }
  return `${formatPoolGroupLabel(bucket.group, buckets)} ${formatPoolWindowLabel(bucket, now, t)}`.trim()
}

export function formatStatusBarSectionLabel(
  p: ProviderRateLimits,
  section: { label: string; window: RateLimitWindow },
  now?: number,
  t?: Translate
): string {
  return isGroupedUsagePool(section.window)
    ? formatPoolShortLabel(section.window, p.buckets ?? [], now, t)
    : section.label
}
