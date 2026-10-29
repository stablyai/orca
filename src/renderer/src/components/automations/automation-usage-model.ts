import { getIntlLocale, translate } from '@/i18n/i18n'
import type { AutomationRunUsage } from '../../../../shared/automations-types'

// Keep retained-run summaries shared across owning authorities; only display formatting belongs to the renderer.
export type { AutomationUsageSummary } from '../../../../shared/automation-usage-summary'
export { summarizeAutomationRunUsage } from '../../../../shared/automation-usage-summary'

export function formatAutomationTokens(value: number | null | undefined): string {
  if (!value) {
    return '0'
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  }
  return value.toLocaleString(getIntlLocale())
}

export function formatAutomationCost(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'n/a'
  }
  if (value > 0 && value < 0.01) {
    return `$${value.toFixed(4)}`
  }
  return `$${value.toFixed(2)}`
}

export function getAutomationUsageStatusLabel(
  usage: AutomationRunUsage | null | undefined
): string {
  if (!usage || usage.status === 'unavailable') {
    return (
      usage?.unavailableMessage ??
      translate('auto.components.automations.AutomationsPage.usageUnavailable', 'Usage unavailable')
    )
  }
  const count = usage.totalTokens ?? 0
  // count drives CLDR plural selection; tokens is the compact display form.
  return translate(
    'auto.components.automations.usage.tokensAndCost',
    '{{tokens}} tokens · {{cost}}',
    {
      count,
      tokens: formatAutomationTokens(usage.totalTokens),
      cost: formatAutomationCost(usage.estimatedCostUsd),
      defaultValue_one: '{{tokens}} token · {{cost}}'
    }
  )
}
