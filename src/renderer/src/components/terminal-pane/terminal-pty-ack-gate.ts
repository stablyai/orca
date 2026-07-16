import { e2eConfig } from '@/lib/e2e-config'

type E2eTerminalPtyAckGateSnapshot = {
  gatedPtyCount: number
  heldAckCount: number
  heldAckChars: number
}

type E2eTerminalPtyAckGateApi = {
  hold: (ptyIds: string[]) => void
  release: () => void
  snapshot: () => E2eTerminalPtyAckGateSnapshot
}

type E2eTerminalPtyAckGateWindow = Window & {
  __terminalPtyAckGate?: E2eTerminalPtyAckGateApi
}

const e2eTerminalAckGatePtyIds = new Set<string>()
const e2eTerminalAckGateHeldChars = new Map<string, number>()
// Why: monotonic per-PTY totals of processed chars, mirrored to main as
// TCP-style cumulative ACKs so a lost ACK message never becomes permanent
// in-flight debt. Cleared on pty:exit so a reused id restarts aligned with
// main's fresh accounting; a renderer reload resets it with the page.
const processedPtyCharTotals = new Map<string, number>()

function sendPtyAck(ptyId: string, chars: number): void {
  const processedChars = (processedPtyCharTotals.get(ptyId) ?? 0) + chars
  processedPtyCharTotals.set(ptyId, processedChars)
  // Why: keep the legacy per-chunk delta alongside the cumulative total so an
  // older main (dev hot-reload mix) still credits deltas.
  window.api.pty.ackData?.(ptyId, chars, processedChars)
}

function releaseE2eTerminalAckGate(): void {
  const held = Array.from(e2eTerminalAckGateHeldChars.entries())
  e2eTerminalAckGatePtyIds.clear()
  e2eTerminalAckGateHeldChars.clear()
  for (const [ptyId, chars] of held) {
    sendPtyAck(ptyId, chars)
  }
}

export function exposeE2eTerminalPtyAckGate(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  // Why: perf tests need to force main-process renderer-delivery pressure
  // without changing production ACK behavior or dropping terminal output.
  const target = window as E2eTerminalPtyAckGateWindow
  target.__terminalPtyAckGate ??= {
    hold: (ptyIds) => {
      releaseE2eTerminalAckGate()
      for (const ptyId of ptyIds) {
        e2eTerminalAckGatePtyIds.add(ptyId)
      }
    },
    release: releaseE2eTerminalAckGate,
    snapshot: () => {
      let heldAckChars = 0
      for (const chars of e2eTerminalAckGateHeldChars.values()) {
        heldAckChars += chars
      }
      return {
        gatedPtyCount: e2eTerminalAckGatePtyIds.size,
        heldAckCount: e2eTerminalAckGateHeldChars.size,
        heldAckChars
      }
    }
  }
}

export function ackPtyData(ptyId: string, chars: number): void {
  // Why: held e2e-gate chars stay out of the cumulative total too, so a
  // delivery-resync probe cannot leak them past the simulated backpressure.
  if (e2eTerminalAckGatePtyIds.has(ptyId)) {
    e2eTerminalAckGateHeldChars.set(ptyId, (e2eTerminalAckGateHeldChars.get(ptyId) ?? 0) + chars)
    return
  }
  sendPtyAck(ptyId, chars)
}

// ─── Parse-deferred ACK crediting ───────────────────────────────────
// Why: ACKing at dispatcher enqueue made main's 512KB in-flight window mean
// "bytes RECEIVED", not "bytes PARSED" — under flood the renderer's write
// queue grew unbounded behind instant ACKs, main saw no backpressure, crossed
// its pending cap, and dropped output (rc.7.perf DSR timeouts). Crediting is
// now deferred to the output scheduler's consume point, so in-flight becomes
// true parse backpressure and main's producer flow control pauses the shell
// instead of dropping.

type DeferredPtyAckCredit = {
  ptyId: string
  chars: number
  claimed: boolean
  credited: boolean
}

let currentDeliveryCredit: DeferredPtyAckCredit | null = null

function creditDeferredPtyAck(credit: DeferredPtyAckCredit): void {
  // Why fire-once: split queue chunks and discard paths may both touch the
  // same delivery; the invariant is exactly one credit per delivered chunk.
  if (credit.credited) {
    return
  }
  credit.credited = true
  ackPtyData(credit.ptyId, credit.chars)
}

/** Runs one pty:data delivery with a parse-deferred ACK credit. If the
 *  handler hands bytes to the output scheduler, the claimed credit fires when
 *  the scheduler consumes (writes or discards) them; any credit left
 *  unclaimed fires here at return, so a chunk the handler drops outright can
 *  never leave main's in-flight window permanently open. */
export function deliverPtyDataWithDeferredAck(
  ptyId: string,
  chars: number,
  deliver: () => void
): void {
  const credit: DeferredPtyAckCredit = { ptyId, chars, claimed: false, credited: false }
  currentDeliveryCredit = credit
  try {
    deliver()
  } finally {
    currentDeliveryCredit = null
    if (!credit.claimed) {
      creditDeferredPtyAck(credit)
    }
  }
}

/** Claims the in-progress delivery's credit for the output scheduler. Returns
 *  a fire-once callback, or null when outside a delivery or already claimed
 *  (only the FIRST scheduler write of a delivery carries the credit). */
export function takeCurrentPtyDeliveryAckCredit(): (() => void) | null {
  const credit = currentDeliveryCredit
  if (!credit || credit.claimed) {
    return null
  }
  credit.claimed = true
  return () => creditDeferredPtyAck(credit)
}

export function getProcessedPtyCharTotals(): Record<string, number> {
  return Object.fromEntries(processedPtyCharTotals)
}

export function clearProcessedPtyCharTotal(ptyId: string): void {
  processedPtyCharTotals.delete(ptyId)
}
