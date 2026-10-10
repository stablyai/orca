import type { AutomationRun, AutomationRunStatus } from './automations-types'

export type AutomationUsageSummary = {
  knownRuns: number
  unavailableRuns: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  /** Newest retained run's status, so list filters never fetch run history. Optional: older projections omit it. */
  lastRunStatus?: AutomationRunStatus | null
  lastRunAt?: number | null
}

/** Bounded aggregate over an authority's retained runs; never fetches history. */
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
  let latest: AutomationRun | null = null

  for (const run of runs) {
    if (!latest || run.createdAt > latest.createdAt) {
      latest = run
    }
    const usage = run.usage
    if (!usage || usage.status !== 'known') {
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
    estimatedCostUsd: hasKnownCost ? estimatedCostUsd : null,
    lastRunStatus: latest?.status ?? null,
    lastRunAt: latest ? (latest.dispatchedAt ?? latest.startedAt ?? latest.createdAt ?? null) : null
  }
}
