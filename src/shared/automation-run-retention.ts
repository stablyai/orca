import { isFinalAutomationRunStatus, type AutomationRun } from './automations-types'

export const MAX_AUTOMATION_RUNS_PER_AUTOMATION = 100

// Why: the whole state blob is re-serialized on every save, so an unbounded
// automationRuns made each flush() permanently slower (28.5 MB → 210 ms blocked).
export function pruneAutomationRuns(
  runs: readonly AutomationRun[],
  maxPerAutomation: number = MAX_AUTOMATION_RUNS_PER_AUTOMATION
): AutomationRun[] {
  const kept = new Set<string>()
  // Why: a dispatched run's completion can land hours later, and
  // updateAutomationRun throws if its row is gone — only final runs are evictable.
  const finalRuns = runs.filter((run) => isFinalAutomationRunStatus(run.status))
  for (const automationRuns of Map.groupBy(finalRuns, (run) => run.automationId).values()) {
    // Why: `createdAt` is the append time; `scheduledFor` breaks ties so runs
    // minted in the same millisecond drop in a stable, reproducible order.
    automationRuns.sort((a, b) => b.createdAt - a.createdAt || b.scheduledFor - a.scheduledFor)
    // Why: clamp — a negative `slice` end drops from the tail instead of keeping nothing.
    for (const run of automationRuns.slice(0, Math.max(0, maxPerAutomation))) {
      kept.add(run.id)
    }
  }

  // Survivors keep their original append order — callers index by position.
  return runs.filter((run) => kept.has(run.id) || !isFinalAutomationRunStatus(run.status))
}

/**
 * Stamp `runNumber` onto legacy runs that predate the field. Must run before
 * {@link pruneAutomationRuns} so the surviving runs carry their true numbers and
 * numbering never restarts.
 *
 * Numbers continue from the highest number the automation already carries, not from
 * the run's append position: a downgrade to a pre-`runNumber` build appends unnumbered
 * runs after pruned survivors numbered 101+, and a position would reissue one of those.
 */
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
