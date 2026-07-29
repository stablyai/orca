// Why: xterm reports every keystroke, and one store write per key wakes every zustand
// subscriber in the app. Hibernation — the only real consumer — is a >=60s idle timeout,
// so the leading edge of a typing burst writes immediately (keeping subscriber-visible
// behavior identical for the first key) and the rest collapse into one trailing flush.
// Imperative readers merge the pending value, so they never observe a stale stamp.

export const TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS = 500

// Why: the gate map only needs panes typed into within the window; prune above this size.
const GATE_PRUNE_SIZE = 256

export type TerminalInputActivityEntries = readonly (readonly [string, number])[]

export type TerminalInputActivityCommit = {
  /** Leading-edge write; may create the pane key. */
  insert: (paneKey: string, timestamp: number) => void
  /** Trailing flush; must only advance pane keys the store still has. */
  refreshExisting: (entries: TerminalInputActivityEntries) => void
}

const pendingByPaneKey = new Map<string, number>()
const lastWrittenByPaneKey = new Map<string, number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pendingCommit: TerminalInputActivityCommit | null = null

function pruneGate(now: number): void {
  if (lastWrittenByPaneKey.size <= GATE_PRUNE_SIZE) {
    return
  }
  for (const [paneKey, writtenAt] of lastWrittenByPaneKey) {
    // Why: entries past the window already pass the gate, so dropping them changes nothing.
    if (
      now - writtenAt >= TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS &&
      !pendingByPaneKey.has(paneKey)
    ) {
      lastWrittenByPaneKey.delete(paneKey)
    }
  }
}

export function recordTerminalInputActivity(args: {
  paneKey: string
  timestamp: number
  /** True when the store has no stamp for this pane yet, so the first stamp must land now. */
  forceWrite?: boolean
  commit: TerminalInputActivityCommit
}): void {
  const { paneKey, timestamp, commit } = args
  const lastWrittenAt = lastWrittenByPaneKey.get(paneKey)
  if (
    args.forceWrite === true ||
    lastWrittenAt === undefined ||
    timestamp - lastWrittenAt >= TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS
  ) {
    pendingByPaneKey.delete(paneKey)
    lastWrittenByPaneKey.set(paneKey, timestamp)
    pruneGate(timestamp)
    commit.insert(paneKey, timestamp)
    return
  }
  pendingByPaneKey.set(paneKey, timestamp)
  pendingCommit = commit
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushTerminalInputActivity()
    }, TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS)
    // Why: renderer-only timer; never hold the Node event loop open under test runners.
    ;(flushTimer as unknown as { unref?: () => void }).unref?.()
  }
}

/** Lands every coalesced stamp now. Safe to call from teardown paths. */
export function flushTerminalInputActivity(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const commit = pendingCommit
  pendingCommit = null
  if (pendingByPaneKey.size === 0 || !commit) {
    pendingByPaneKey.clear()
    return
  }
  const entries = [...pendingByPaneKey]
  pendingByPaneKey.clear()
  for (const [paneKey, timestamp] of entries) {
    lastWrittenByPaneKey.set(paneKey, timestamp)
  }
  commit.refreshExisting(entries)
}

/** Freshest input stamp for a pane, including a not-yet-flushed keystroke. */
export function readLastTerminalInputAt(
  stored: Record<string, number | undefined>,
  paneKey: string
): number | undefined {
  const storedAt = stored[paneKey]
  // Why: a pane key teardown removed must stay removed — never revive it from pending.
  if (storedAt === undefined) {
    return undefined
  }
  const pendingAt = pendingByPaneKey.get(paneKey)
  return pendingAt !== undefined && pendingAt > storedAt ? pendingAt : storedAt
}

/** Same map with pending stamps applied; returns the input reference when nothing is pending. */
export function mergePendingTerminalInputActivity<T extends Record<string, number | undefined>>(
  stored: T
): T {
  if (pendingByPaneKey.size === 0) {
    return stored
  }
  let next: Record<string, number | undefined> | null = null
  for (const [paneKey, pendingAt] of pendingByPaneKey) {
    const storedAt = stored[paneKey]
    if (storedAt === undefined || storedAt >= pendingAt) {
      continue
    }
    next ??= { ...stored }
    next[paneKey] = pendingAt
  }
  return (next as T | null) ?? stored
}

export function resetTerminalInputActivityCoalescingForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingByPaneKey.clear()
  lastWrittenByPaneKey.clear()
  pendingCommit = null
}

export function getPendingTerminalInputActivityCountForTests(): number {
  return pendingByPaneKey.size
}
