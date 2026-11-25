/** Ref-count raw-byte consumers so main sees only first-acquire/last-release interest; model-recoverable eager buffers do not hold hidden delivery open. */
const ptyDeliveryInterestRefCounts = new Map<string, number>()

function sendPtyDeliveryInterest(ptyId: string, interested: boolean): void {
  ;(globalThis as { window?: Window }).window?.api?.pty?.setPtyDeliveryInterest?.(ptyId, interested)
}

/** Acquire byte-delivery interest; the returned release is idempotent. */
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
