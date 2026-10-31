import type { PersistedState } from './persisted-state-types'
import type { AutomationRun } from './automations-types'

export function activateAutomationRunAttention(state: PersistedState, now: number): PersistedState {
  if (state.automationFailureSeenVersion === 1) {
    return state
  }
  return {
    ...state,
    automationFailureSeenVersion: 1,
    automationRuns: (state.automationRuns ?? []).map((run) =>
      run.status === 'dispatch_failed' && run.failureSeenAt === undefined
        ? { ...run, failureSeenAt: now }
        : run
    )
  }
}

export function unseenAutomationFailures(runs: readonly AutomationRun[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const run of runs) {
    if (run.status === 'dispatch_failed' && run.failureSeenAt === undefined) {
      counts.set(run.automationId, (counts.get(run.automationId) ?? 0) + 1)
    }
  }
  return counts
}
