// Why not the sibling reader that re-exports this: it imports `node:child_process`, which the
// renderer cannot load — reaching it blanks the window at module evaluation.
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../../../../shared/process-table-snapshot'

/**
 * Picks the delay until a pane's next cadence inspection.
 *
 * Local panes all resolve out of one TTL-deduped process-table snapshot, and the inspection
 * queue collapses every shared-observation task enqueued in the same tick onto a single host
 * capture. Independent per-pane jitter defeated that: panes drifted apart, each landing in its
 * own tick and forking its own `ps`. Snapping to a grid anchored at the epoch puts same-tier
 * panes back in one tick, so N panes cost one capture instead of N.
 *
 * The pull-forward is clamped to the process-table snapshot TTL, so a pane never polls more than
 * that early and never later than its tier interval. A pane off the grid therefore walks onto it
 * in at most `baseMs / TTL` steps, costing at most one extra inspection in total, and no
 * inspection is ever delayed.
 *
 * Alignment is scoped to genuinely idle panes: no foreground agent and no pane activity inside
 * the hot window. A pane that just produced output keeps its exact interval, so the bounded
 * post-activity cadence is unchanged, and the error-backoff path keeps its jitter — spreading
 * retries across panes is the point when a host has just failed.
 */

export function nextCadenceInspectionDelayMs(args: {
  baseMs: number
  hasConsecutiveErrors: boolean
  alignToSharedGrid: boolean
  now: number
  random?: () => number
}): number {
  const { alignToSharedGrid, baseMs, hasConsecutiveErrors, now } = args
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    return 0
  }
  if (hasConsecutiveErrors || !alignToSharedGrid) {
    const random = args.random ?? Math.random
    return Math.round(baseMs * (1 + (random() * 0.2 - 0.1)))
  }
  const deadline = Math.floor((now + baseMs) / baseMs) * baseMs
  const earliest = Math.max(1, baseMs - PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS)
  return Math.min(baseMs, Math.max(earliest, deadline - now))
}
