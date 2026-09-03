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
  recordInbound: () => void
  dispose: () => void
}

export function createRemoteTerminalStreamWatchdog(
  onStall: (stall: RemoteTerminalStreamStall) => void
): RemoteTerminalStreamWatchdog {
  let responseTimer: ReturnType<typeof setTimeout> | null = null
  let deliveryTimer: ReturnType<typeof setTimeout> | null = null
  let outstandingDeliveryBytes = 0
  // Why separate from parse credit: the host reopens its window on ACK frames, so bytes parsed but not yet ACKed are still the credit whose loss stops output.
  let unacknowledgedBytes = 0
  let deliveryPendingSinceMs: number | null = null
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
  // Why anchored, never restarted: a deadline re-armed by sibling settles is postponed forever, and one cleared at zero parse credit can only re-arm from inbound output — which is what the stall stops.
  const syncDeliveryTimer = (): void => {
    if (disposed || outstandingDeliveryBytes + unacknowledgedBytes <= 0) {
      clearDeliveryTimer()
      deliveryPendingSinceMs = null
      return
    }
    deliveryPendingSinceMs ??= Date.now()
    if (deliveryTimer) {
      return
    }
    const remainingMs = Math.max(
      0,
      REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS - (Date.now() - deliveryPendingSinceMs)
    )
    deliveryTimer = setTimeout(() => trip('delivery-credit-timeout'), remainingMs)
  }

  return {
    beginOutputDelivery(bytes) {
      outstandingDeliveryBytes += bytes
      unacknowledgedBytes += bytes
      syncDeliveryTimer()
      let settled = false
      return () => {
        if (settled || disposed) {
          return
        }
        settled = true
        outstandingDeliveryBytes = Math.max(0, outstandingDeliveryBytes - bytes)
        syncDeliveryTimer()
      }
    },
    recordOutputAcknowledged(bytes) {
      if (disposed) {
        return
      }
      unacknowledgedBytes = Math.max(0, unacknowledgedBytes - bytes)
      syncDeliveryTimer()
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
    recordInbound() {
      lastInboundAtMs = Date.now()
      clearResponseTimer()
    },
    dispose() {
      disposed = true
      commandResponseProbePending = false
      clearResponseTimer()
      clearDeliveryTimer()
      outstandingDeliveryBytes = 0
      unacknowledgedBytes = 0
      deliveryPendingSinceMs = null
    }
  }
}
