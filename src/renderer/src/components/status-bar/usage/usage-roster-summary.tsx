import React from 'react'
import type { Translate } from '@/i18n/use-translate'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import type { UsageSection } from './usage-headline-sections'
import { UsageBar, UsageValue } from './usage-meter'

export function getOllamaUsageSummary(
  p: ProviderRateLimits,
  t: Translate,
  intlLocale: string
): string | null {
  if (p.provider !== 'ollama') {
    return null
  }
  const spend = p.ollamaUsageTotals?.spentUsd
  if (spend != null) {
    return t('auto.components.status.bar.UsageRosterPanel.ollamaSpend', '${{value0}} spent (30d)', {
      value0: spend.toFixed(2)
    })
  }
  const requestCount = p.ollamaUsageTotals?.requestCount
  if (requestCount != null) {
    return t(
      'auto.components.status.bar.UsageRosterPanel.ollamaRequests',
      '{{value0}} requests (30d)',
      { value0: requestCount.toLocaleString(intlLocale) }
    )
  }
  const balance = p.extraUsage?.unit === 'currency' ? p.extraUsage.balance : null
  return balance != null
    ? t('auto.components.status.bar.UsageRosterPanel.ollamaBalance', '${{value0}} left', {
        value0: balance.toFixed(2)
      })
    : null
}

export function DetailMetric({
  section,
  label,
  display,
  title
}: {
  section: UsageSection
  label: string
  display: UsagePercentageDisplay
  title?: string
}): React.JSX.Element {
  return (
    <span
      data-usage-window={section.label}
      title={title}
      className="flex shrink-0 items-center gap-1.5"
    >
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <UsageBar
        usedPercent={section.window.usedPercent}
        display={display}
        className="h-[5px] w-7"
      />
      <UsageValue
        usedPercent={section.window.usedPercent}
        display={display}
        className="text-[11px]"
      />
    </span>
  )
}
