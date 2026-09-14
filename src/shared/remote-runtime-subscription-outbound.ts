import WebSocket from 'ws'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { createWsOutboundBackpressureQueue } from './ws-outbound-backpressure-queue'

export type RemoteRuntimeOutboundSocketMemory = {
  canSend: (bytes: number, alreadyRetained?: boolean) => boolean
  release: () => void
}

export type RemoteRuntimeOutboundMemoryBudget = {
  claimQueuedBytes: (bytes: number) => (() => void) | null
  registerBufferedAmount: (
    readBufferedAmount: () => number
  ) => RemoteRuntimeOutboundSocketMemory | null
}

export type RemoteRuntimeOutboundQueueOptions = {
  softCapBytes: number
  maxQueuedBytes: number
  maxQueuedFrames: number
  maxDrainFramesPerTurn?: number
}

const SUBSCRIPTION_REQUEST_SOFT_CAP_BYTES = 1024 * 1024
const SUBSCRIPTION_REQUEST_MAX_QUEUED_BYTES = 16 * 1024 * 1024
const SUBSCRIPTION_REQUEST_MAX_QUEUED_FRAMES = 64

/**
 * The subscription's outbound side: one backpressure queue for binary stream frames, one for
 * request frames, and the socket-memory admission both answer to.
 *
 * Why: client input (keystrokes) must never be dropped under backpressure. Hold encrypted frames
 * in order while bufferedAmount is over the cap and drain as it clears; a wedged link (hard cap)
 * fails the socket so the renderer resubscribes and replays a fresh snapshot.
 */
export class RemoteRuntimeSubscriptionOutbound {
  private socketMemory: RemoteRuntimeOutboundSocketMemory | null = null
  private socketMemoryCloseSource: WebSocket | null = null
  private binaryQueue: ReturnType<typeof createWsOutboundBackpressureQueue<Buffer>> | null = null
  private requestQueue: ReturnType<typeof createWsOutboundBackpressureQueue<string>> | null = null

  constructor(
    private readonly options: {
      memoryBudget?: RemoteRuntimeOutboundMemoryBudget
      binaryQueue?: RemoteRuntimeOutboundQueueOptions
      fail: (error: RemoteRuntimeClientError) => void
    }
  ) {}

  get hasRetainedCloseSource(): boolean {
    return this.socketMemoryCloseSource !== null
  }

  enqueueBinary(socket: WebSocket, frame: Buffer): boolean {
    return this.ensureBinaryQueue(socket)?.enqueue(frame) ?? false
  }

  enqueueRequest(socket: WebSocket, frame: string): boolean {
    return this.ensureRequestQueue(socket)?.enqueue(frame) ?? false
  }

  releaseQueues(): void {
    this.binaryQueue?.dispose()
    this.binaryQueue = null
    this.requestQueue?.dispose()
    this.requestQueue = null
  }

  releaseSocketMemory(): void {
    this.socketMemory?.release()
    this.socketMemory = null
    this.socketMemoryCloseSource = null
  }

  // Why not release on detach: queued bytes stay charged until the socket really closes.
  retainSocketMemoryUntilClose(socket: WebSocket): void {
    if (socket.readyState === WebSocket.CLOSED) {
      this.releaseSocketMemory()
      return
    }
    if (this.socketMemoryCloseSource === socket) {
      return
    }
    this.socketMemoryCloseSource = socket
    socket.once('close', () => this.releaseSocketMemory())
  }

  private ensureSocketMemory(socket: WebSocket): boolean {
    const memoryBudget = this.options.memoryBudget
    if (!memoryBudget || this.socketMemory) {
      return true
    }
    this.socketMemory = memoryBudget.registerBufferedAmount(() => socket.bufferedAmount)
    if (this.socketMemory) {
      return true
    }
    this.options.fail(
      new RemoteRuntimeClientError(
        'remote_runtime_unavailable',
        'Remote Orca runtime outbound memory admission failed; reconnecting.'
      )
    )
    return false
  }

  private memoryAdmission(): {
    canSend: (bytes: number, alreadyRetained?: boolean) => boolean
    claimQueuedBytes?: (bytes: number) => (() => void) | null
  } {
    const memoryBudget = this.options.memoryBudget
    return {
      canSend: (bytes, alreadyRetained) =>
        this.socketMemory?.canSend(bytes, alreadyRetained) ?? true,
      ...(memoryBudget
        ? { claimQueuedBytes: (bytes: number) => memoryBudget.claimQueuedBytes(bytes) }
        : {})
    }
  }

  private ensureBinaryQueue(
    socket: WebSocket
  ): ReturnType<typeof createWsOutboundBackpressureQueue<Buffer>> | null {
    if (!this.binaryQueue) {
      if (!this.ensureSocketMemory(socket)) {
        return null
      }
      this.binaryQueue = createWsOutboundBackpressureQueue<Buffer>({
        send: (frame) => socket.send(frame, { binary: true }),
        byteLengthOf: (frame) => frame.byteLength,
        getBufferedAmount: () => socket.bufferedAmount,
        isWritable: () => socket.readyState === WebSocket.OPEN,
        onOverflow: () =>
          this.options.fail(
            new RemoteRuntimeClientError(
              'remote_runtime_unavailable',
              'Remote Orca runtime send buffer overflow; reconnecting.'
            )
          ),
        ...this.options.binaryQueue,
        ...this.memoryAdmission()
      })
    }
    return this.binaryQueue
  }

  private ensureRequestQueue(
    socket: WebSocket
  ): ReturnType<typeof createWsOutboundBackpressureQueue<string>> | null {
    if (!this.requestQueue) {
      if (!this.ensureSocketMemory(socket)) {
        return null
      }
      this.requestQueue = createWsOutboundBackpressureQueue<string>({
        send: (frame) => socket.send(frame),
        byteLengthOf: (frame) => Buffer.byteLength(frame),
        getBufferedAmount: () => socket.bufferedAmount,
        isWritable: () => socket.readyState === WebSocket.OPEN,
        onOverflow: () =>
          this.options.fail(
            new RemoteRuntimeClientError(
              'remote_runtime_unavailable',
              'Remote runtime subscription request buffer overflow; reconnecting.'
            )
          ),
        softCapBytes: SUBSCRIPTION_REQUEST_SOFT_CAP_BYTES,
        maxQueuedBytes: SUBSCRIPTION_REQUEST_MAX_QUEUED_BYTES,
        maxQueuedFrames: SUBSCRIPTION_REQUEST_MAX_QUEUED_FRAMES,
        ...this.memoryAdmission()
      })
    }
    return this.requestQueue
  }
}
