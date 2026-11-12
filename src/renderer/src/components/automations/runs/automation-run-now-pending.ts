import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { AutomationRunNowPending } from '../automation-page-state'

// Hosts stamp createdAt on their clock; tolerate a little skew when matching the new run.
const RUN_NOW_CLOCK_SKEW_MS = 5_000

/** The run a Run now request started is in the listed history. */
export function isAutomationRunNowListed(
  pending: AutomationRunNowPending,
  runs: readonly Pick<AutomationRun, 'id' | 'trigger' | 'createdAt'>[]
): boolean {
  return runs.some((run) =>
    pending.runId
      ? run.id === pending.runId
      : run.trigger === 'manual' && run.createdAt >= pending.requestedAt - RUN_NOW_CLOCK_SKEW_MS
  )
}

/**
 * Run now is busy only between the click and its run being listed. Other runs in progress,
 * scheduled or stuck, never block it.
 */
export function isAutomationRunNowPending(
  pending: AutomationRunNowPending | null,
  rowKey: string | null | undefined,
  runs: readonly Pick<AutomationRun, 'id' | 'trigger' | 'createdAt'>[]
): boolean {
  return pending !== null && pending.rowKey === rowKey && !isAutomationRunNowListed(pending, runs)
}
