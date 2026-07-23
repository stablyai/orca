export const WEB_RUNTIME_OUTBOUND_MAX_BUFFERED_BYTES = 16 * 1024 * 1024
export const WEB_RUNTIME_OUTBOUND_MAX_QUEUED_BYTES = 32 * 1024 * 1024
export const WEB_RUNTIME_OUTBOUND_MAX_QUEUED_FRAMES = 4_096
export const WEB_RUNTIME_OUTBOUND_MAX_SOCKET_SOURCES = 65
export const WEB_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES = 16 * 1024 * 1024
export const WEB_RUNTIME_MAX_PREPARED_RPC_BYTES = 32 * 1024 * 1024

export type WebRuntimeOutboundSocketMemory = {
  canSend: (bytes: number) => boolean
  release: () => void
}

export type WebRuntimeOutboundMemoryBudget = {
  claimQueuedBytes: (bytes: number) => (() => void) | null
  claimPreparedRpcBytes: (bytes: number) => (() => void) | null
  claimSubscriptionBytes: (bytes: number) => (() => void) | null
  registerBufferedAmount: (readBufferedAmount: () => number) => WebRuntimeOutboundSocketMemory
}

export function createWebRuntimeOutboundMemoryBudget(options?: {
  maxBufferedBytes?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
  maxPreparedRpcBytes?: number
  maxSocketSources?: number
  maxSubscriptionBytes?: number
}): WebRuntimeOutboundMemoryBudget {
  const maxBufferedBytes = options?.maxBufferedBytes ?? WEB_RUNTIME_OUTBOUND_MAX_BUFFERED_BYTES
  const maxQueuedBytes = options?.maxQueuedBytes ?? WEB_RUNTIME_OUTBOUND_MAX_QUEUED_BYTES
  const maxQueuedFrames = options?.maxQueuedFrames ?? WEB_RUNTIME_OUTBOUND_MAX_QUEUED_FRAMES
  const maxPreparedRpcBytes = options?.maxPreparedRpcBytes ?? WEB_RUNTIME_MAX_PREPARED_RPC_BYTES
  const maxSocketSources = options?.maxSocketSources ?? WEB_RUNTIME_OUTBOUND_MAX_SOCKET_SOURCES
  const maxSubscriptionBytes =
    options?.maxSubscriptionBytes ?? WEB_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES
  const bufferedSources = new Set<() => number>()
  let queuedBytes = 0
  let queuedFrames = 0
  let preparedRpcBytes = 0
  let subscriptionBytes = 0

  const bufferedBytes = (): number => {
    let total = 0
    for (const read of bufferedSources) {
      try {
        const value = read()
        if (Number.isFinite(value) && value > 0) {
          total += value
        }
      } catch {
        // Closed browser sockets can reject late reads before their close callback releases the source.
      }
    }
    return total
  }

  return {
    claimQueuedBytes(bytes): (() => void) | null {
      if (
        !Number.isFinite(bytes) ||
        bytes < 0 ||
        queuedFrames >= maxQueuedFrames ||
        queuedBytes + bytes > maxQueuedBytes
      ) {
        return null
      }
      queuedBytes += bytes
      queuedFrames += 1
      return createRelease(() => {
        queuedBytes -= bytes
        queuedFrames -= 1
      })
    },
    claimPreparedRpcBytes(bytes): (() => void) | null {
      if (!Number.isFinite(bytes) || bytes < 0 || preparedRpcBytes + bytes > maxPreparedRpcBytes) {
        return null
      }
      preparedRpcBytes += bytes
      return createRelease(() => {
        preparedRpcBytes -= bytes
      })
    },
    claimSubscriptionBytes(bytes): (() => void) | null {
      if (
        !Number.isFinite(bytes) ||
        bytes < 0 ||
        subscriptionBytes + bytes > maxSubscriptionBytes
      ) {
        return null
      }
      subscriptionBytes += bytes
      return createRelease(() => {
        subscriptionBytes -= bytes
      })
    },
    registerBufferedAmount(readBufferedAmount) {
      if (bufferedSources.size >= maxSocketSources) {
        throw new Error('Remote runtime outbound socket tracking limit exceeded')
      }
      bufferedSources.add(readBufferedAmount)
      let registered = true
      return {
        canSend: (bytes): boolean =>
          registered &&
          Number.isFinite(bytes) &&
          bytes >= 0 &&
          bytes <= maxBufferedBytes - bufferedBytes(),
        release: createRelease(() => {
          registered = false
          bufferedSources.delete(readBufferedAmount)
        })
      }
    }
  }
}

function createRelease(release: () => void): () => void {
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    release()
  }
}
