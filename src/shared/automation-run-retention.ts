import { isFinalAutomationRunStatus, type AutomationRun } from './automations-types'

export const MAX_AUTOMATION_RUNS_PER_AUTOMATION = 100

/** Delivery history may acquire a result later without pinning history or workspace metadata. */
export function isAutomationRunHistory(
  run: Pick<AutomationRun, 'status' | 'sessionKind'>
): boolean {
  return (
    isFinalAutomationRunStatus(run.status) ||
    (run.status === 'dispatched' && run.sessionKind !== 'chat')
  )
}

// Bound runs because every save serializes the whole blob (28.5MB once blocked flush for 210ms).
export function pruneAutomationRuns(
  runs: readonly AutomationRun[],
  maxPerAutomation: number = MAX_AUTOMATION_RUNS_PER_AUTOMATION
): AutomationRun[] {
  const kept = new Set<string>()
  // A transient observer detaches if bounded history evicts its delivery row.
  const finalRuns = runs.filter(isAutomationRunHistory)
  for (const automationRuns of Map.groupBy(finalRuns, (run) => run.automationId).values()) {
    // Order by append createdAt then scheduledFor for stable same-millisecond eviction.
    if (automationRuns.length > maxPerAutomation) {
      automationRuns.sort((a, b) => b.createdAt - a.createdAt || b.scheduledFor - a.scheduledFor)
    }
    // Why: clamp — a negative `slice` end drops from the tail instead of keeping nothing.
    for (const run of automationRuns.slice(0, Math.max(0, maxPerAutomation))) {
      kept.add(run.id)
    }
  }

  // Survivors keep their original append order — callers index by position.
  return runs.filter((run) => kept.has(run.id) || !isAutomationRunHistory(run))
}

/** Number legacy runs before pruning. Continue above retained maximums, never append positions: pre-runNumber downgrades can append blanks after pruned 101+ survivors and would reissue titles. */
export function backfillAutomationRunNumbers(runs: readonly AutomationRun[]): AutomationRun[] {
  const highestPerAutomation = new Map<string, number>()
  for (const run of runs) {
    if (run.runNumber !== undefined) {
      const highest = highestPerAutomation.get(run.automationId) ?? 0
      highestPerAutomation.set(run.automationId, Math.max(highest, run.runNumber))
    }
  }
  return runs.map((run) => {
    if (run.runNumber !== undefined) {
      return run
    }
    const runNumber = (highestPerAutomation.get(run.automationId) ?? 0) + 1
    highestPerAutomation.set(run.automationId, runNumber)
    return { ...run, runNumber }
  })
}

/** Next run number for one automation, given only the runs still retained. */
export function nextAutomationRunNumber(runsForAutomation: readonly AutomationRun[]): number {
  // Why: seed with the count so legacy runs that predate `runNumber` still advance.
  return (
    runsForAutomation.reduce(
      (n, run) => Math.max(n, run.runNumber ?? 0),
      runsForAutomation.length
    ) + 1
  )
}
