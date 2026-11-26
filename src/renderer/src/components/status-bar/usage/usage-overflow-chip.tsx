import React from 'react'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { useTranslate } from '@/i18n/use-translate'
import { formatUsageChipTitle } from './usage-chip-title'

/** Stands in for the chips a narrow bar leaves out; its tooltip names them and the popover lists them. */
export function UsageOverflowChip({
  hidden,
  providerCount,
  display,
  hostLabel
}: {
  hidden: readonly ProviderRateLimits[]
  providerCount: number
  display: UsagePercentageDisplay
  hostLabel?: string
}): React.JSX.Element {
  const t = useTranslate()
  const names = hidden.map((p) => formatUsageChipTitle(p, display, t)).join(', ')
  return (
    <span
      title={[
        t('auto.components.status.bar.StatusBar.hiddenUsageProviders', 'Also: {{value0}}', {
          value0: names
        }),
        hostLabel
      ]
        .filter(Boolean)
        .join('\n')}
      className="inline-grid h-4 items-center justify-items-center rounded-full border border-border px-1.5 text-[11px] font-medium tabular-nums text-foreground"
    >
      {/* Why: reserve the widest count so the measured width doesn't depend on how many are hidden. */}
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        +{providerCount}
      </span>
      <span className="col-start-1 row-start-1">+{Math.max(1, hidden.length)}</span>
    </span>
  )
}
