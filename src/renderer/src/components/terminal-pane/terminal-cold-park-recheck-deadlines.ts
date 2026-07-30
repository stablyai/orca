/**
 * Why: parking decisions change only at the cold-park, hot-retain, retention
 * TTL, and post-measure cool-down deadlines, so the verdict effects schedule
 * one recheck at the next deadline instead of polling.
 */
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  TERMINAL_TAB_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_MS
} from './terminal-hidden-view-parking'

function nextColdParkDeadlineDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs: number
  hotRetainMs: number
  retentionTtlMs?: number
  parkCooldownUntilMs?: number | null
}): number | null {
  if (!args.parkingEnabled || args.hiddenSinceMs === null) {
    return null
  }
  const pendingDeadlines = [
    args.hiddenSinceMs + args.coldParkDelayMs,
    args.hiddenSinceMs + args.hotRetainMs,
    ...(args.retentionTtlMs !== undefined ? [args.hiddenSinceMs + args.retentionTtlMs] : []),
    // Why: the cool-down holds past-deadline candidates out of the parked set; without this wakeup nothing re-parks them.
    ...(args.parkCooldownUntilMs != null ? [args.parkCooldownUntilMs] : [])
  ].filter((deadlineMs) => deadlineMs > args.nowMs)
  return pendingDeadlines.length === 0 ? null : Math.min(...pendingDeadlines) - args.nowMs
}

export function getTerminalWorktreeColdParkRecheckDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
  /** Provided only for retention-budget candidates so their TTL wakes the verdict effect. */
  retentionTtlMs?: number
  parkCooldownUntilMs?: number | null
}): number | null {
  return nextColdParkDeadlineDelayMs({
    parkingEnabled: args.parkingEnabled,
    hiddenSinceMs: args.hiddenSinceMs,
    nowMs: args.nowMs,
    coldParkDelayMs: args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS,
    ...(args.retentionTtlMs !== undefined ? { retentionTtlMs: args.retentionTtlMs } : {}),
    parkCooldownUntilMs: args.parkCooldownUntilMs
  })
}

export function getTerminalTabColdParkRecheckDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
  parkCooldownUntilMs?: number | null
}): number | null {
  return nextColdParkDeadlineDelayMs({
    parkingEnabled: args.parkingEnabled,
    hiddenSinceMs: args.hiddenSinceMs,
    nowMs: args.nowMs,
    coldParkDelayMs: args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_TAB_HOT_RETAIN_MS,
    parkCooldownUntilMs: args.parkCooldownUntilMs
  })
}
