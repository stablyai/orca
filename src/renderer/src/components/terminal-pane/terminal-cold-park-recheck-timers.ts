/**
 * Pending cold-park recheck timers, keyed by tab and reconciled by deadline.
 *
 * Why reconcile instead of clear-and-re-arm: the cold-park effect must re-run on
 * every tab-model write, because watcher coverage is re-derived from store and
 * registry state the park key cannot encode (terminal-cold-park-verdict-loop
 * pins what breaks when it stops). But every recheck deadline is absolute —
 * hiddenSince plus a fixed policy window, a cool-down, or a pin expiry — so a
 * re-run that recomputes the same deadline was cancelling a timer only to re-arm
 * it for the same instant. A background title flood paid two timer syscalls per
 * hidden tab per write for no scheduling change.
 */

export type TerminalTabColdParkRecheckTimer = { timerId: number; deadlineMs: number }
export type TerminalTabColdParkRecheckTimers = Map<string, TerminalTabColdParkRecheckTimer>

export function clearTerminalTabColdParkRecheckTimers(
  timers: TerminalTabColdParkRecheckTimers
): void {
  for (const timer of timers.values()) {
    window.clearTimeout(timer.timerId)
  }
  timers.clear()
}

/** Arms, holds, or cancels one timer per tab so only moved deadlines reschedule. */
export function reconcileTerminalTabColdParkRecheckTimers(args: {
  timers: TerminalTabColdParkRecheckTimers
  deadlineMsByTabId: ReadonlyMap<string, number>
  nowMs: number
  onDeadline: () => void
}): void {
  for (const [tabId, timer] of args.timers) {
    if (args.deadlineMsByTabId.get(tabId) !== timer.deadlineMs) {
      window.clearTimeout(timer.timerId)
      args.timers.delete(tabId)
    }
  }
  for (const [tabId, deadlineMs] of args.deadlineMsByTabId) {
    if (args.timers.has(tabId)) {
      continue
    }
    const timerId = window.setTimeout(() => {
      args.timers.delete(tabId)
      args.onDeadline()
    }, deadlineMs - args.nowMs)
    args.timers.set(tabId, { timerId, deadlineMs })
  }
}
