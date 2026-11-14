import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type {
  AutomationRunNowPending,
  AutomationRunNowPendingByRow
} from '../automation-page-state'

/** A request whose run never shows up (history read failed) releases Run now after this. */
export const RUN_NOW_PENDING_MAX_MS = 20_000
/** A dispatch that has not answered at all is released after this long, measured from the click. */
export const RUN_NOW_DISPATCH_MAX_MS = 60_000

/** When a request stops holding Run now busy, whatever row is selected. */
export function automationRunNowPendingDeadline(pending: AutomationRunNowPending): number {
  return pending.acknowledgedAt === null
    ? pending.requestedAt + RUN_NOW_DISPATCH_MAX_MS
    : pending.acknowledgedAt + RUN_NOW_PENDING_MAX_MS
}

/**
 * Record the host's answer to a request. An answer that arrives after the request's own
 * dispatch deadline has passed ends it instead of starting a fresh wait.
 */
export function acknowledgeAutomationRunNowPending(
  pending: AutomationRunNowPending,
  runId: string | null,
  now: number
): AutomationRunNowPending | null {
  if (now >= pending.requestedAt + RUN_NOW_DISPATCH_MAX_MS) {
    return null
  }
  return { ...pending, runId, acknowledgedAt: now }
}

// Hosts stamp createdAt on their clock; tolerate a little skew when matching the new run.
const RUN_NOW_CLOCK_SKEW_MS = 5_000

/** The run a Run now request started is in the listed history. */
export function isAutomationRunNowListed(
  pending: AutomationRunNowPending,
  runs: readonly Pick<AutomationRun, 'id' | 'trigger' | 'createdAt'>[]
): boolean {
  if (pending.acknowledgedAt === null) {
    return false
  }
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

/** Record a new request for its row, replacing only that row's earlier one. */
export function startAutomationRunNowPending(
  byRow: AutomationRunNowPendingByRow,
  pending: AutomationRunNowPending
): AutomationRunNowPendingByRow {
  return { ...byRow, [pending.rowKey]: pending }
}

/**
 * Apply an answer (failure, acknowledgement, timeout) to a row's busy state only if it still
 * belongs to the request that got it; a later click on that row owns the slot by then.
 * Returning null clears the row.
 */
export function settleAutomationRunNowPending(
  byRow: AutomationRunNowPendingByRow,
  rowKey: string,
  requestId: string,
  update: (pending: AutomationRunNowPending) => AutomationRunNowPending | null
): AutomationRunNowPendingByRow {
  const current = byRow[rowKey]
  if (current?.requestId !== requestId) {
    return byRow
  }
  const next = update(current)
  if (next) {
    return { ...byRow, [rowKey]: next }
  }
  const { [rowKey]: _settled, ...rest } = byRow
  return rest
}
