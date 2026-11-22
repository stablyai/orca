const LOG_INTERVAL_MS = 30_000
const lastLogByPartition = new Map<string, { at: number; suppressed: number }>()

/** Traces a host frame that drops any of a worktree's terminal tabs, at most once per partition per interval. */
export function logHostTerminalTabsShrunk(
  environmentId: string,
  worktreeId: string,
  previousTabs: readonly { id: string }[],
  nextTabs: readonly { id: string }[],
  now: number
): void {
  const kept = new Set(nextTabs.map((tab) => tab.id))
  const dropped = previousTabs.filter((tab) => !kept.has(tab.id)).map((tab) => tab.id)
  if (dropped.length === 0) {
    return
  }
  const key = `${environmentId}\0${worktreeId}`
  const last = lastLogByPartition.get(key)
  if (last && now - last.at < LOG_INTERVAL_MS) {
    last.suppressed += 1
    return
  }
  lastLogByPartition.set(key, { at: now, suppressed: 0 })
  console.info(
    `[web-session-tabs-sync] host ${environmentId} frame dropped ${dropped.length} of ${worktreeId}'s ${previousTabs.length} terminal tab(s), now ${nextTabs.length}${last?.suppressed ? ` (${last.suppressed} earlier drop(s) unlogged)` : ''}:`,
    dropped
  )
}
