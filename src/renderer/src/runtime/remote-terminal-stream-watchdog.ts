export const REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS = 10_000
export const REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS = 30_000

export type RemoteTerminalStreamStall = {
  inactiveForMs: number
  outstandingDeliveryBytes: number
  reason: 'command-response-timeout' | 'delivery-credit-timeout'
}

export type RemoteTerminalStreamWatchdog = {
  beginOutputDelivery: (bytes: number) => () => void
  /** Bytes whose ACK frame reached the transport, releasing the host's window. */
  recordOutputAcknowledged: (bytes: number) => void
  completeCommandResponseProbe: () => void
  recordCommandInput: (text: string) => void
  /** Only live output answers a pending command; control frames prove transport activity alone. */
  recordInbound: (carriesOutput: boolean) => void
  dispose: () => void
}

export function createRemoteTerminalStreamWatchdog(
  onStall: (stall: RemoteTerminalStreamStall) => void
): RemoteTerminalStreamWatchdog {
  let responseTimer: ReturnType<typeof setTimeout> | null = null
  let deliveryTimer: ReturnType<typeof setTimeout> | null = null
  let outstandingDeliveryBytes = 0
  // Unsettled deliveries in arrival order; the oldest one's start is the stall anchor.
  const unsettledDeliveries = new Set<{ startedAtMs: number }>()
  // Host credit reopens on ACK frames; parsed-but-unacked bytes remain credit whose loss can stall output.
  // Why a head index: one ACK can cover thousands of tiny frames, and repeated shift() is O(n) each.
  let unacknowledgedChunks: { bytes: number; startedAtMs: number }[] = []
  let unacknowledgedHead = 0
  let lastInboundAtMs = Date.now()
  let commandResponseProbePending = false
  let disposed = false

  const clearResponseTimer = (): void => {
    if (responseTimer) {
      clearTimeout(responseTimer)
      responseTimer = null
    }
  }
  const clearDeliveryTimer = (): void => {
    if (deliveryTimer) {
      clearTimeout(deliveryTimer)
      deliveryTimer = null
    }
  }
  const trip = (reason: RemoteTerminalStreamStall['reason']): void => {
    if (disposed) {
      return
    }
    clearResponseTimer()
    if (reason === 'command-response-timeout') {
      commandResponseProbePending = true
    } else {
      disposed = true
      clearDeliveryTimer()
    }
    onStall({
      inactiveForMs: Math.max(0, Date.now() - lastInboundAtMs),
      outstandingDeliveryBytes,
      reason
    })
  }
  const oldestPendingAtMs = (): number => {
    const oldestDelivery = unsettledDeliveries.values().next().value
    return Math.min(
      oldestDelivery?.startedAtMs ?? Infinity,
      unacknowledgedChunks[unacknowledgedHead]?.startedAtMs ?? Infinity
    )
  }
  // Why oldest pending: flowing output always has bytes in flight; only the oldest byte not moving is a stall.
  // Why arm once and recheck on fire: the anchor only moves later, so re-arming per frame would churn timers on the output hot path.
  const armDeliveryTimer = (anchorMs: number): void => {
    const remainingMs = Math.max(
      0,
      REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS - (Date.now() - anchorMs)
    )
    deliveryTimer = setTimeout(() => {
      deliveryTimer = null
      const currentAnchorMs = oldestPendingAtMs()
      if (disposed || currentAnchorMs === Infinity) {
        return
      }
      if (Date.now() - currentAnchorMs >= REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS) {
        trip('delivery-credit-timeout')
        return
      }
      armDeliveryTimer(currentAnchorMs)
    }, remainingMs)
  }
  const ensureDeliveryTimer = (): void => {
    if (disposed || deliveryTimer) {
      return
    }
    const anchorMs = oldestPendingAtMs()
    if (anchorMs !== Infinity) {
      armDeliveryTimer(anchorMs)
    }
  }

  return {
    beginOutputDelivery(bytes) {
      if (disposed) {
        return () => {}
      }
      const delivery = { startedAtMs: Date.now() }
      outstandingDeliveryBytes += bytes
      unsettledDeliveries.add(delivery)
      if (bytes > 0) {
        unacknowledgedChunks.push({ bytes, startedAtMs: delivery.startedAtMs })
      }
      ensureDeliveryTimer()
      let settled = false
      return () => {
        if (settled || disposed) {
          return
        }
        settled = true
        outstandingDeliveryBytes = Math.max(0, outstandingDeliveryBytes - bytes)
        unsettledDeliveries.delete(delivery)
      }
    },
    recordOutputAcknowledged(bytes) {
      if (disposed) {
        return
      }
      let remaining = bytes
      while (remaining > 0 && unacknowledgedHead < unacknowledgedChunks.length) {
        const oldest = unacknowledgedChunks[unacknowledgedHead]
        const consumed = Math.min(oldest.bytes, remaining)
        oldest.bytes -= consumed
        remaining -= consumed
        if (oldest.bytes === 0) {
          unacknowledgedHead += 1
        }
      }
      // Why compact only past half: keeps slice cost amortized O(1) per consumed chunk.
      if (unacknowledgedHead === unacknowledgedChunks.length) {
        unacknowledgedChunks = []
        unacknowledgedHead = 0
      } else if (
        unacknowledgedHead > 1024 &&
        unacknowledgedHead * 2 > unacknowledgedChunks.length
      ) {
        unacknowledgedChunks = unacknowledgedChunks.slice(unacknowledgedHead)
        unacknowledgedHead = 0
      }
    },
    completeCommandResponseProbe() {
      commandResponseProbePending = false
    },
    recordCommandInput(text) {
      if (disposed || commandResponseProbePending || responseTimer || !/[\r\n]/u.test(text)) {
        return
      }
      responseTimer = setTimeout(
        () => trip('command-response-timeout'),
        REMOTE_TERMINAL_COMMAND_RESPONSE_TIMEOUT_MS
      )
    },
    recordInbound(carriesOutput) {
      lastInboundAtMs = Date.now()
      if (carriesOutput) {
        clearResponseTimer()
      }
    },
    dispose() {
      disposed = true
      commandResponseProbePending = false
      clearResponseTimer()
      clearDeliveryTimer()
      outstandingDeliveryBytes = 0
      unsettledDeliveries.clear()
      unacknowledgedChunks = []
      unacknowledgedHead = 0
    }
  }
}
