import type { AutomationRun, AutomationRunStatus } from '../../../../shared/automations-types'
import type { AutomationLastRunStatusLookup } from '../../../../shared/automations-filter'

export type AutomationLastRun = {
  status: AutomationRunStatus
  at: number
}

/** Build automationId -> most-recent run from a flat runs list. Runs arrive
 *  newest-first (store sort), so the first occurrence per automation wins;
 *  scheduledFor is compared as a guard against any out-of-order input. */
export function buildAutomationLastRunByAutomationId(
  runs: readonly AutomationRun[]
): Map<string, AutomationLastRun> {
  const byId = new Map<string, AutomationLastRun>()
  for (const run of runs) {
    const at = run.startedAt ?? run.scheduledFor
    const existing = byId.get(run.automationId)
    if (!existing || at > existing.at) {
      byId.set(run.automationId, { status: run.status, at })
    }
  }
  return byId
}

/** Plain status lookup consumed by the shared filterAutomations predicates. */
export function toLastRunStatusLookup(
  byId: ReadonlyMap<string, AutomationLastRun>
): AutomationLastRunStatusLookup {
  const lookup: Record<string, AutomationRunStatus> = {}
  for (const [automationId, lastRun] of byId) {
    lookup[automationId] = lastRun.status
  }
  return lookup
}
