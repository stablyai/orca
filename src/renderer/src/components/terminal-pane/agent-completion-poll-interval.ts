// Import the dependency-free snapshot constant; its reader re-export pulls node:child_process into the renderer.
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../../../../shared/process-table-snapshot'

/** Align idle panes to one host-capture tick, pulling forward by at most snapshot TTL; preserve hot cadence and error jitter. */

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
