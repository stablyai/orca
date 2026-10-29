import { e2eConfig } from '@/lib/e2e-config'
import {
  deliverTerminalDataWithDeferredCredit,
  takeCurrentTerminalDeliveryCredit
} from '@/lib/pane-manager/terminal-delivery-credit'

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
// Cumulative processed-character ACKs recover lost messages; clear on PTY exit/reload to align reused IDs with main’s fresh totals.
const processedPtyCharTotals = new Map<string, number>()

function sendPtyAck(ptyId: string, chars: number): void {
  const processedChars = (processedPtyCharTotals.get(ptyId) ?? 0) + chars
  processedPtyCharTotals.set(ptyId, processedChars)
  // Keep per-chunk deltas for older main during mixed-version hot reload.
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
  // E2E pressure holds ACKs without changing production behavior or discarding output.
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
  // Withhold cumulative credit too so resync cannot bypass simulated backpressure.
  if (e2eTerminalAckGatePtyIds.has(ptyId)) {
    e2eTerminalAckGateHeldChars.set(ptyId, (e2eTerminalAckGateHeldChars.get(ptyId) ?? 0) + chars)
    return
  }
  sendPtyAck(ptyId, chars)
}

// Credit at scheduler consumption, not receipt: early ACKs hide xterm backlog from main’s flow control and cause output drops.

/** Claimed credit fires on scheduler write/discard; unclaimed credit fires at handler return so dropped chunks cannot strand main’s in-flight debt. */
export function deliverPtyDataWithDeferredAck(
  ptyId: string,
  chars: number,
  deliver: () => void
): void {
  deliverTerminalDataWithDeferredCredit(() => ackPtyData(ptyId, chars), deliver)
}

export function takeCurrentPtyDeliveryAckCredit(): (() => void) | null {
  return takeCurrentTerminalDeliveryCredit()
}

export function getProcessedPtyCharTotals(): Record<string, number> {
  return Object.fromEntries(processedPtyCharTotals)
}

export function clearProcessedPtyCharTotal(ptyId: string): void {
  processedPtyCharTotals.delete(ptyId)
}
