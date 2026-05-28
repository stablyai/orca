import type { AutomationRun, AutomationRunUsage } from '../../../../shared/automations-types'

export type AutomationUsageSummary = {
  knownRuns: number
  unavailableRuns: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
}

export function summarizeAutomationRunUsage(
  runs: readonly AutomationRun[]
): AutomationUsageSummary {
  let knownRuns = 0
  let unavailableRuns = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheTokens = 0
  let reasoningOutputTokens = 0
  let totalTokens = 0
  let estimatedCostUsd = 0
  let hasKnownCost = false

  for (const run of runs) {
    const usage = run.usage
    if (!usage) {
      unavailableRuns++
      continue
    }
    if (usage.status !== 'known') {
      unavailableRuns++
      continue
    }
    knownRuns++
    inputTokens += usage.inputTokens ?? 0
    outputTokens += usage.outputTokens ?? 0
    cacheTokens += (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    reasoningOutputTokens += usage.reasoningOutputTokens ?? 0
    totalTokens += usage.totalTokens ?? 0
    if (usage.estimatedCostUsd !== null) {
      estimatedCostUsd += usage.estimatedCostUsd
      hasKnownCost = true
    }
  }

  return {
    knownRuns,
    unavailableRuns,
    inputTokens,
    outputTokens,
    cacheTokens,
    reasoningOutputTokens,
    totalTokens,
    estimatedCostUsd: hasKnownCost ? estimatedCostUsd : null
  }
}

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
