/**
 * Renderer-side delivery-interest registry for the Phase-4 hidden-delivery
 * gate.
 *
 * Why: main only drops hidden PTY byte delivery while NO renderer party needs
 * raw bytes. Dispatcher sidecars and eager pre-mount buffers register
 * interest here; ref-counted so main sees only the 0↔1 transitions.
 */
const ptyDeliveryInterestRefCounts = new Map<string, number>()

function sendPtyDeliveryInterest(ptyId: string, interested: boolean): void {
  ;(globalThis as { window?: Window }).window?.api?.pty?.setPtyDeliveryInterest?.(ptyId, interested)
}

/** Acquire a delivery-interest hold for a PTY. Returns a release fn that is
 *  safe to call more than once (only the first call decrements). */
export function acquirePtyDeliveryInterest(ptyId: string): () => void {
  const next = (ptyDeliveryInterestRefCounts.get(ptyId) ?? 0) + 1
  ptyDeliveryInterestRefCounts.set(ptyId, next)
  if (next === 1) {
    sendPtyDeliveryInterest(ptyId, true)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const current = ptyDeliveryInterestRefCounts.get(ptyId) ?? 0
    if (current <= 1) {
      ptyDeliveryInterestRefCounts.delete(ptyId)
      sendPtyDeliveryInterest(ptyId, false)
    } else {
      ptyDeliveryInterestRefCounts.set(ptyId, current - 1)
    }
  }
}

/** Test seam: drop ref counts between tests (no IPC is sent). */
export function _resetPtyDeliveryInterestForTest(): void {
  ptyDeliveryInterestRefCounts.clear()
}
