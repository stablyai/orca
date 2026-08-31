import type { AutomationRunUsage } from '../../../../shared/automations-types'

// Why: the summary is computed by whichever authority owns the retained runs, so
// it lives in shared code; only the display formatting below is renderer-only.
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
  return value.toLocaleString()
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
    return usage?.unavailableMessage ?? 'Usage unavailable'
  }
  const cost = formatAutomationCost(usage.estimatedCostUsd)
  const tokens = formatAutomationTokens(usage.totalTokens)
  return `${tokens} tokens · ${cost}`
}
