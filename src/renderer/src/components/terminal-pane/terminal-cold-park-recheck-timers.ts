// Reconcile absolute deadlines instead of rearming: title writes must still recheck watcher coverage, but unchanged deadlines need no timer syscalls.

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
