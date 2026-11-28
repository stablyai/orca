import React from 'react'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { StatusBarUsageMode } from '../../../../../shared/status-bar/status-bar-usage-mode'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getStatusBarUsageSections } from '../composition/status-bar-usage-sections'

export function usageChipShowsPercentage(
  p: ProviderRateLimits | null,
  mode: StatusBarUsageMode,
  t?: Translate
): boolean {
  return getStatusBarUsageSections(p, mode, t).length > 0
}

export function UsageUnitLabel({
  display,
  compact = false
}: {
  display: UsagePercentageDisplay
  /** Compact bar: dimmer label with a hairline separating it from the numbers. */
  compact?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label =
    display === 'used'
      ? t('auto.components.status.bar.usageUnitLabel.used', 'Used')
      : t('auto.components.status.bar.usageUnitLabel.remaining', 'Remaining')
  if (!compact) {
    return <span className="text-muted-foreground">{label}</span>
  }
  return (
    <span className="inline-flex items-center gap-3.5 text-muted-foreground">
      {label}
      <span aria-hidden="true" className="h-3 w-px bg-muted-foreground/60" />
    </span>
  )
}
