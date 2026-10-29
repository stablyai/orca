import {
  markRestoredStaleCodexSessionsForRestart,
  type CodexPaneScanResult
} from './codex-session-restart'
import { isForeignMachineCodexPtyId } from './codex-pane-selection-lane'

// Coalesce startup binds, then retry reattach beyond the measured 5.8s Windows tail; keep retries bounded so unresolved panes cannot become polling loops.
const SWEEP_ATTEMPT_DELAYS_MS = [300, 1500, 4000, 10_000, 20_000] as const

// Keep per-PTY due times and target the earliest; a new pane’s shorter delay must not consume another’s later retry rung.
const dueAtByPtyId = new Map<string, number>()
const attemptsByPtyId = new Map<string, number>()
const notifiedPtyIds = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushTimerDueAt: number | null = null

/** Queue on real pane/PTY binding; startup hydration alone has no attached PTYs to inspect and would never retry. */
export function notifyCodexPaneBoundForStaleSweep(ptyId: string): void {
  if (notifiedPtyIds.has(ptyId)) {
    return
  }
  // Foreign PTYs never have daemon host registry entries; reject before queueing pointless 15s RPC retries.
  if (isForeignMachineCodexPtyId(ptyId)) {
    return
  }
  queue(ptyId, SWEEP_ATTEMPT_DELAYS_MS[0])
  armForEarliestDue()
}

/** Check restored PTYs without pane mounts so never-revealed tabs can recover stale-account notices after app restart; notify guards reject foreign IDs. */
export function sweepRestoredCodexPanesForStaleAccounts(state: {
  ptyIdsByTabId: Record<string, string[]>
}): void {
  for (const ptyIds of Object.values(state.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      notifyCodexPaneBoundForStaleSweep(ptyId)
    }
  }
}

export function resetCodexStalePaneSweepForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushTimerDueAt = null
  dueAtByPtyId.clear()
  attemptsByPtyId.clear()
  notifiedPtyIds.clear()
}

function queue(ptyId: string, delayMs: number): void {
  const dueAt = Date.now() + delayMs
  const existing = dueAtByPtyId.get(ptyId)
  // Why: a rebind of an already-queued PTY must never push its look later.
  dueAtByPtyId.set(ptyId, existing === undefined ? dueAt : Math.min(existing, dueAt))
}

function armForEarliestDue(): void {
  let earliestDueAt: number | null = null
  for (const dueAt of dueAtByPtyId.values()) {
    if (earliestDueAt === null || dueAt < earliestDueAt) {
      earliestDueAt = dueAt
    }
  }
  if (earliestDueAt === null) {
    return
  }
  if (flushTimer !== null) {
    if (flushTimerDueAt !== null && flushTimerDueAt <= earliestDueAt) {
      return
    }
    clearTimeout(flushTimer)
  }
  flushTimerDueAt = earliestDueAt
  flushTimer = setTimeout(
    () => {
      flushTimer = null
      flushTimerDueAt = null
      void flush()
    },
    Math.max(0, earliestDueAt - Date.now())
  )
}

function takeDuePtyIds(): string[] {
  const now = Date.now()
  const duePtyIds: string[] = []
  for (const [ptyId, dueAt] of dueAtByPtyId) {
    // Coalesce first inspections freely, but spend existing retry rungs only at their own due time.
    if (dueAt <= now || !attemptsByPtyId.has(ptyId)) {
      duePtyIds.push(ptyId)
    }
  }
  for (const ptyId of duePtyIds) {
    dueAtByPtyId.delete(ptyId)
  }
  return duePtyIds
}

function shouldRetry(scan: CodexPaneScanResult): boolean {
  // Only unusable reads or mid-reattach Codex shell sightings warrant retry; eligible-but-unlisted is authoritatively not stale.
  return !scan.eligible && (scan.inconclusive || scan.launchedCodex)
}

function queueNextRung(ptyId: string): void {
  const attempt = (attemptsByPtyId.get(ptyId) ?? 0) + 1
  const delayMs = SWEEP_ATTEMPT_DELAYS_MS[attempt]
  if (delayMs === undefined) {
    attemptsByPtyId.delete(ptyId)
    return
  }
  attemptsByPtyId.set(ptyId, attempt)
  queue(ptyId, delayMs)
}

async function flush(): Promise<void> {
  const ptyIds = takeDuePtyIds()
  if (ptyIds.length === 0) {
    // Why: a timer can fire a hair early; re-aim it rather than dropping the queue.
    armForEarliestDue()
    return
  }

  let scans: CodexPaneScanResult[]
  try {
    scans = await markRestoredStaleCodexSessionsForRestart({ ptyIds })
  } catch (err) {
    console.warn('Codex stale-pane restart sweep failed:', err)
    // Treat throws as inconclusive retry attempts and re-arm untouched later panes so no queue entry is stranded.
    for (const ptyId of ptyIds) {
      queueNextRung(ptyId)
    }
    armForEarliestDue()
    return
  }

  const scanByPtyId = new Map(scans.map((scan) => [scan.ptyId, scan]))
  for (const ptyId of ptyIds) {
    const scan = scanByPtyId.get(ptyId)
    if (scan?.notified === true) {
      notifiedPtyIds.add(ptyId)
      attemptsByPtyId.delete(ptyId)
      continue
    }
    // An unlisted PTY may not have reached its tab yet; retry like an unusable process read.
    if (scan !== undefined && !shouldRetry(scan)) {
      attemptsByPtyId.delete(ptyId)
      continue
    }
    queueNextRung(ptyId)
  }

  armForEarliestDue()
}
