import { getIntlLocale, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AutomationUsageSummary } from '../../../../../shared/automations/history/automation-usage-summary'
import type { AutomationRunUsage } from '../../../../../shared/automations/history/automation-run'

// Keep retained-run summaries shared across owning authorities; only display formatting belongs to the renderer.

export function formatAutomationTokens(
  value: number | null | undefined,
  intlLocale: string = getIntlLocale()
): string {
  if (!value) {
    return '0'
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  }
  return value.toLocaleString(intlLocale)
}

export function formatAutomationCost(
  value: number | null | undefined,
  t: Translate = translate
): string {
  if (value === null || value === undefined) {
    return t('auto.components.automations.usage.costUnavailable', 'n/a')
  }
  if (value > 0 && value < 0.01) {
    return `$${value.toFixed(4)}`
  }
  return `$${value.toFixed(2)}`
}

export function getAutomationUsageStatusLabel(
  usage: AutomationRunUsage | null | undefined,
  t: Translate = translate,
  intlLocale?: string
): string {
  if (!usage || usage.status === 'unavailable') {
    return (
      usage?.unavailableMessage ??
      t('auto.components.automations.AutomationsPage.usageUnavailable', 'Usage unavailable')
    )
  }
  const count = usage.totalTokens ?? 0
  // count drives CLDR plural selection; tokens is the compact display form.
  return t('auto.components.automations.usage.tokensAndCost', '{{tokens}} tokens · {{cost}}', {
    count,
    tokens: formatAutomationTokens(usage.totalTokens, intlLocale),
    cost: formatAutomationCost(usage.estimatedCostUsd, t),
    defaultValue_one: '{{tokens}} token · {{cost}}'
  })
}

export function formatAutomationUsageSummary(
  summary: AutomationUsageSummary | undefined,
  t: Translate = translate,
  intlLocale?: string
): string {
  if (!summary || summary.unavailableRuns > 0) {
    return summary?.knownRuns
      ? usageAmountText(summary, t, intlLocale)
      : t('auto.components.automations.AutomationsPage.usageUnavailable', 'Usage unavailable')
  }
  return summary.knownRuns > 0
    ? usageAmountText(summary, t, intlLocale)
    : t('auto.components.automations.AutomationsPage.noRunUsageYet', 'No run usage yet')
}

function usageAmountText(
  summary: AutomationUsageSummary,
  t: Translate = translate,
  intlLocale?: string
): string {
  return t(
    'auto.components.automations.AutomationsPage.runUsageSummaryTokens',
    '{{cost}} est. · {{tokens}} tokens',
    {
      count: summary.totalTokens,
      cost: formatAutomationCost(summary.estimatedCostUsd, t),
      tokens: formatAutomationTokens(summary.totalTokens, intlLocale),
      defaultValue_one: '{{cost}} est. · {{tokens}} token'
    }
  )
}
