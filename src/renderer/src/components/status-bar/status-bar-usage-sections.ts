import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { isCursorUsageBucket } from '../../../../shared/cursor-usage-buckets'
import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { getUsageHeadlineSection } from './UsageRosterPanel'

export type StatusBarUsageSection = {
  key: string
  window: RateLimitWindow
  label: string
  labelFirst?: boolean
}

const STATUS_BAR_BUCKET_NAMES = new Set(['Flash', 'Pro', '1.5 Pro'])

/** The percentages actually shown in a provider chip, also used by the row's unit label. */
export function getStatusBarUsageSections(
  p: ProviderRateLimits | null,
  mode: StatusBarUsageMode
): StatusBarUsageSection[] {
  if (!p || p.status === 'idle' || p.status === 'unavailable') {
    return []
  }
  if (mode === 'compact') {
    const headline = getUsageHeadlineSection(p)
    return headline ? [{ key: 'headline', ...headline }] : []
  }
  if (p.buckets?.length) {
    // Antigravity pool names vary by account tier; Gemini's experimental pools stay hidden.
    const buckets = p.buckets.filter(
      (bucket) =>
        p.provider === 'antigravity' ||
        STATUS_BAR_BUCKET_NAMES.has(bucket.name) ||
        isCursorUsageBucket(bucket.name)
    )
    if (buckets.length > 0) {
      return buckets.map((bucket) => ({
        key: bucket.name,
        window: bucket,
        label: bucket.name,
        labelFirst: true
      }))
    }
    const fallback = p.session ?? p.monthly ?? p.weekly
    return fallback
      ? [{ key: 'fallback', window: fallback, label: formatRateLimitWindowChipLabel(fallback) }]
      : []
  }
  return [
    p.session
      ? { key: 'session', window: p.session, label: formatRateLimitWindowChipLabel(p.session) }
      : null,
    p.weekly
      ? { key: 'weekly', window: p.weekly, label: formatRateLimitWindowChipLabel(p.weekly) }
      : null,
    p.fableWeekly
      ? {
          key: 'fableWeekly',
          window: p.fableWeekly,
          label: translate('auto.components.status.bar.StatusBar.a79c64f87e', 'Fable')
        }
      : null,
    // Monthly-only providers keep their limit inline; other plans show it in the details.
    p.monthly && !p.session && !p.weekly
      ? { key: 'monthly', window: p.monthly, label: formatRateLimitWindowChipLabel(p.monthly) }
      : null
  ].filter((section) => section !== null)
}
