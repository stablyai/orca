import {
  markRestoredStaleCodexSessionsForRestart,
  type CodexPaneScanResult
} from './codex-session-restart'

// Why: the first delay coalesces the startup burst of binds and lets
// updateTabPtyId (written just after the layout binding) land, since the scan
// walks tabs. The rest cover a reattached daemon shell that answers
// `inspectProcess` with terminal_gone for a beat. The tail is sized off live
// Windows 11 runs, where the 5.8s rung is what raised the notice in all three
// (macOS resolved on the first): the ladder used to end exactly where the
// slowest measured box landed, so a colder reattach fell off it and the pane
// stayed silently stale. Bounded on purpose — this is a hint, and a pane that
// never resolves must not become a polling loop.
const SWEEP_ATTEMPT_DELAYS_MS = [300, 1500, 4000, 10_000, 20_000] as const

// Why: each PTY owns its rung, so the queue has to carry a per-PTY due time. One
// shared timer coalesces the startup burst, but it must always target the
// EARLIEST due entry — a single timer that drained everything let one pane's
// short delay consume another's later rung and cut its ladder short.
const dueAtByPtyId = new Map<string, number>()
const attemptsByPtyId = new Map<string, number>()
const notifiedPtyIds = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushTimerDueAt: number | null = null

/**
 * Queues a stale-account check for a PTY that has just bound to a pane.
 *
 * Why a bind signal rather than a startup call: nothing is attached while the
 * session hydrates, so a one-shot sweep inspects zero PTYs and never retries.
 * Every real bind rewrites the pane→PTY layout binding, which is the earliest
 * point the daemon shell can be inspected at all.
 */
export function notifyCodexPaneBoundForStaleSweep(ptyId: string): void {
  if (notifiedPtyIds.has(ptyId)) {
    return
  }
  queue(ptyId, SWEEP_ATTEMPT_DELAYS_MS[0])
  armForEarliestDue()
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
    // Why: folding a never-inspected PTY into an earlier sweep is what coalesces
    // the startup burst, and costs it nothing. A PTY already waiting on a retry
    // rung must wait for its own due time, or that rung is spent for free.
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
  // Why: an eligible-but-unlisted pane got an authoritative "not stale" from the
  // registry, so only an unusable read or a Codex tab still showing its shell
  // (mid-reattach) can change answer on a later attempt.
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
    // Why: a thrown sweep is no more conclusive than an unusable process read, so
    // spend a rung rather than dropping these panes. Re-aiming is what keeps the
    // panes this sweep never touched — parked on a later rung, and no longer
    // holding the timer — from being stranded with nothing left to fire them.
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
    // Why: a PTY the scan never saw is not yet listed against its tab, which is
    // the same "ask again shortly" case as an unusable process read.
    if (scan !== undefined && !shouldRetry(scan)) {
      attemptsByPtyId.delete(ptyId)
      continue
    }
    queueNextRung(ptyId)
  }

  armForEarliestDue()
}
