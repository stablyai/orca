import type { CodexBackfillGateStatus } from '../../../../shared/codex-backfill-status-types'

export type CodexIndexingPaneState = { lastWatermark: string | null }

export type CodexBackfillGateApi = {
  status: () => Promise<CodexBackfillGateStatus>
  onStatusChanged: (callback: (status: CodexBackfillGateStatus) => void) => () => void
}

// Why: belt over the push event — a pane whose subscription raced the single
// statusChanged broadcast must not stay parked forever.
export const CODEX_BACKFILL_GATE_REPOLL_MS = 20_000

// Why: the prewarm has real give-up paths (60-min deadline, 5 fast exits,
// codex missing) and the scheduler never re-runs on prewarm failure. After
// this deadline the gate fails open: codex launches and, if the index is
// genuinely still running, dies visibly with the toast as the net — today's
// shipped behavior, which beats a pane parked forever. 15 min covers the
// measured 10–13 min reporter-scale index with headroom.
export const CODEX_BACKFILL_GATE_MAX_WAIT_MS = 15 * 60_000

/**
 * Defers a fresh local codex spawn while the target home's session index is
 * incomplete (#11828). Reports progress via onWaiting while deferred, then calls
 * onClear exactly once. Fails open (immediate onClear) when the API is absent
 * (web build) or errors — an IPC failure must never park a pane.
 * Returns a dispose that cancels silently (no onClear) for pane teardown.
 */
export function waitForCodexBackfillGate(args: {
  api: CodexBackfillGateApi | undefined
  onWaiting: (state: CodexIndexingPaneState) => void
  onClear: () => void
  repollMs?: number
  maxWaitMs?: number
}): () => void {
  const api = args.api
  if (!api || typeof api.status !== 'function' || typeof api.onStatusChanged !== 'function') {
    args.onClear()
    return () => {}
  }
  let settled = false
  let repollTimer: ReturnType<typeof setInterval> | null = null
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  const cancel = (): void => {
    settled = true
    unsubscribe?.()
    unsubscribe = null
    if (repollTimer !== null) {
      clearInterval(repollTimer)
      repollTimer = null
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer)
      maxWaitTimer = null
    }
  }
  const clear = (): void => {
    if (settled) {
      return
    }
    cancel()
    args.onClear()
  }
  const handleStatus = (status: CodexBackfillGateStatus): void => {
    if (settled) {
      return
    }
    if (status.pending) {
      args.onWaiting({ lastWatermark: status.lastWatermark })
    } else {
      clear()
    }
  }
  unsubscribe = api.onStatusChanged(handleStatus)
  const poll = (): void => {
    api.status().then(handleStatus, clear)
  }
  repollTimer = setInterval(poll, args.repollMs ?? CODEX_BACKFILL_GATE_REPOLL_MS)
  // Why fail open at a deadline: see CODEX_BACKFILL_GATE_MAX_WAIT_MS.
  maxWaitTimer = setTimeout(clear, args.maxWaitMs ?? CODEX_BACKFILL_GATE_MAX_WAIT_MS)
  poll()
  return cancel
}
