import React from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getStatusBarUsageSections } from './status-bar-usage-sections'

export type UsageUnitLabelState = 'absent' | 'collapsed' | 'shown'

export function usageChipShowsPercentage(
  p: ProviderRateLimits | null,
  mode: StatusBarUsageMode,
  t?: Translate
): boolean {
  return getStatusBarUsageSections(p, mode, t).length > 0
}

export function getUsageUnitLabelState(
  providers: readonly ProviderRateLimits[],
  collapsedProviders: readonly string[],
  mode: StatusBarUsageMode,
  t?: Translate
): UsageUnitLabelState {
  const withPercentage = providers.filter((p) => usageChipShowsPercentage(p, mode, t))
  if (withPercentage.length === 0) {
    return 'absent'
  }
  return withPercentage.every((p) => collapsedProviders.includes(p.provider))
    ? 'collapsed'
    : 'shown'
}

/** Stays measurable while collapsed so the density calculation remains stable. */
export function UsageUnitLabel({
  collapsed,
  display
}: {
  collapsed: boolean
  display: UsagePercentageDisplay
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span
      data-usage-unit
      data-usage-collapsed={collapsed}
      aria-hidden={collapsed}
      className="text-muted-foreground data-[usage-collapsed=true]:invisible data-[usage-collapsed=true]:absolute"
    >
      {display === 'used'
        ? t('auto.components.status.bar.usageUnitLabel.used', 'Used')
        : t('auto.components.status.bar.usageUnitLabel.remaining', 'Remaining')}
    </span>
  )
}
