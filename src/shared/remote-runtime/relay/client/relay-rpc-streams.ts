// The streams a relay client opened on its host, multiplexed on one link: each by the request id that
// opened it, until the host ends it or the client releases it. The phone adds its terminal and
// screencast frames through the hooks; the desktop uses it as is.
import type { RpcResponse } from '../../rpc/rpc-response-shape'
import {
  buildReadyStreamUnsubscribe,
  buildStreamUnsubscribe,
  isReadyIdStream,
  type StreamUnsubscribe
} from './relay-stream-unsubscribe'

export type RelayStreamFrame<TEnvelope> = {
  id: string
  method: string
  params: unknown
  envelope?: TEnvelope
}

export type RelayStream<TEnvelope> = {
  method: string
  params: unknown
  envelope?: TEnvelope
  listener?: (result: unknown) => void
  subscriptionId?: string
  cancelled: boolean
  /** Position in this link's send order, or null while unsent. */
  sendOrder: number | null
  receivedSnapshot?: boolean
}

export type RelayRpcStreamsOptions<TEnvelope> = {
  nextId: () => string
  // A stream's envelope rides its subscribe and unsubscribes alike, so routing reaches one host.
  sendFrame: (frame: RelayStreamFrame<TEnvelope>) => boolean
  waitForConnected: () => Promise<void>
  /** A stream whose release names its own request and never waits for the host's id (the phone's terminals). */
  requestBoundUnsubscribe?: (method: string, params: unknown) => StreamUnsubscribe | null
  /** Sees each opener result of a live stream before its listener, for frames routed by other ids. */
  onOpenerResult?: (id: string, stream: RelayStream<TEnvelope>, result: object) => void
  onRemoved?: (id: string, stream: RelayStream<TEnvelope>) => void
}

const isStreamingOpener = (response: RpcResponse): boolean =>
  response.ok && response.streaming === true

// Include the whole envelope in cleanup-slot identity; sort keys so equivalent routing names the same slot.
function unsubscribeSlot({ method, params }: StreamUnsubscribe, envelope: unknown): string | null {
  if (!('subscriptionId' in params)) {
    return null
  }
  const client =
    'client' in params && typeof params.client === 'object' && params.client !== null
      ? params.client
      : null
  const clientId = client && 'id' in client ? client.id : null
  const routing =
    envelope && typeof envelope === 'object'
      ? Object.entries(envelope).sort(([a], [b]) => (a < b ? -1 : 1))
      : null
  return JSON.stringify([method, params.subscriptionId, clientId, routing])
}

export class RelayRpcStreams<TEnvelope = Record<string, unknown>> {
  private readonly streams = new Map<string, RelayStream<TEnvelope>>()
  private readonly cancelledSubscriptions = new Map<
    string,
    { method: string; unsubscribe?: StreamUnsubscribe; envelope?: TEnvelope }
  >()
  private sendCount = 0

  constructor(private readonly options: RelayRpcStreamsOptions<TEnvelope>) {}

  subscribe(
    method: string,
    params: unknown,
    listener: (result: unknown) => void,
    envelope?: TEnvelope
  ): { id: string; release: () => void } {
    const id = this.options.nextId()
    const stream: RelayStream<TEnvelope> = {
      method,
      params,
      envelope,
      listener,
      cancelled: false,
      sendOrder: null
    }
    this.streams.set(id, stream)
    void this.options
      .waitForConnected()
      .then(() => {
        if (!stream.cancelled) {
          stream.sendOrder = ++this.sendCount
          if (!this.options.sendFrame({ id, method, params: stream.params, envelope })) {
            this.fail(id, stream, 'Connection interrupted')
          }
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Connection interrupted'
        this.fail(id, stream, message, error)
      })
    return { id, release: () => this.cancel(id) }
  }

  /** The live streams, for a caller that rewrites a stream's params before a resend. */
  values(): IterableIterator<RelayStream<TEnvelope>> {
    return this.streams.values()
  }

  /** Whether the response was a stream's; false leaves it to the request/reply path. */
  handleResponse(response: RpcResponse): boolean {
    const cancelled = this.cancelledSubscriptions.get(response.id)
    if (cancelled) {
      this.handleCancelledResponse(response, cancelled)
      return true
    }
    const stream = this.streams.get(response.id)
    if (!stream) {
      return false
    }
    if (!response.ok) {
      this.fail(response.id, stream, response.error.message, response.error)
      return true
    }
    const { result } = response
    if (result && typeof result === 'object') {
      const metadata = result as { subscriptionId?: unknown; type?: unknown }
      if (metadata.type === 'snapshot') {
        stream.receivedSnapshot = true
      }
      if (typeof metadata.subscriptionId === 'string') {
        stream.subscriptionId = metadata.subscriptionId
      }
      this.options.onOpenerResult?.(response.id, stream, result)
      if (metadata.type === 'end') {
        this.finish(response.id, stream, result)
        return true
      }
    }
    if (!stream.cancelled) {
      stream.listener?.(result)
    }
    return true
  }

  /** The link closed: every stream ends with an error frame, as a host close would. */
  failAll(message: string, error?: unknown): void {
    for (const [id, stream] of this.streams) {
      this.fail(id, stream, message, error)
    }
    this.cancelledSubscriptions.clear()
  }

  clear(): void {
    for (const [id, stream] of this.streams) {
      stream.cancelled = true
      this.remove(id)
    }
    this.cancelledSubscriptions.clear()
  }

  private handleCancelledResponse(
    response: RpcResponse,
    cancelled: { method: string; unsubscribe?: StreamUnsubscribe; envelope?: TEnvelope }
  ): void {
    if (!response.ok) {
      this.cancelledSubscriptions.delete(response.id)
      return
    }
    const result = response.result as { subscriptionId?: unknown; type?: unknown } | null
    if (result && typeof result === 'object') {
      if (result.type === 'end') {
        this.cancelledSubscriptions.delete(response.id)
      } else if (result.type === 'snapshot' && cancelled.unsubscribe) {
        this.cancelledSubscriptions.delete(response.id)
        this.send(cancelled.unsubscribe, cancelled.envelope)
      } else if (typeof result.subscriptionId === 'string') {
        this.cancelledSubscriptions.delete(response.id)
        const unsubscribe = buildReadyStreamUnsubscribe(cancelled.method, result.subscriptionId)
        if (unsubscribe) {
          this.send(unsubscribe, cancelled.envelope)
        }
      }
    }
    if (!isStreamingOpener(response)) {
      this.cancelledSubscriptions.delete(response.id)
    }
  }

  private paramsUnsubscribe(method: string, params: unknown, id: string): StreamUnsubscribe | null {
    return (
      this.options.requestBoundUnsubscribe?.(method, params) ??
      buildStreamUnsubscribe(method, params, id)
    )
  }

  private cancel(id: string): void {
    const stream = this.streams.get(id)
    if (!stream || stream.cancelled) {
      return
    }
    stream.cancelled = true
    if (stream.sendOrder !== null) {
      const requestBound = this.options.requestBoundUnsubscribe?.(stream.method, stream.params)
      if (requestBound) {
        this.sendUnsubscribe(requestBound, stream.sendOrder, stream.envelope, id)
      } else {
        this.cancelUnsent(id, stream, stream.sendOrder)
      }
    }
    this.remove(id)
  }

  private cancelUnsent(id: string, stream: RelayStream<TEnvelope>, sendOrder: number): void {
    const byParams = buildStreamUnsubscribe(stream.method, stream.params, id)
    const byReadyId = stream.subscriptionId
      ? buildReadyStreamUnsubscribe(stream.method, stream.subscriptionId)
      : null
    if (byParams && stream.method === 'session.tabs.subscribe' && !stream.receivedSnapshot) {
      // The host registers cleanup only after resolving the initial snapshot.
      this.cancelledSubscriptions.set(id, {
        method: stream.method,
        unsubscribe: byParams,
        envelope: stream.envelope
      })
    } else if (byReadyId ?? byParams) {
      this.sendUnsubscribe((byReadyId ?? byParams)!, sendOrder, stream.envelope)
    } else if (isReadyIdStream(stream.method)) {
      // Keep only the cleanup route while the server assigns its subscription ID.
      this.cancelledSubscriptions.set(id, { method: stream.method, envelope: stream.envelope })
    }
  }

  /** Skip when a same-slot sibling sent later has already evicted this stream on the host. */
  private sendUnsubscribe(
    unsubscribe: StreamUnsubscribe,
    sendOrder: number,
    envelope: TEnvelope | undefined,
    requestId?: string
  ): void {
    if (this.hasNewerSlotOwner(unsubscribe, sendOrder, envelope)) {
      return
    }
    // Check siblings first: older hosts strip requestId and would otherwise evict the live same-slot stream.
    const params = requestId ? { ...unsubscribe.params, requestId } : unsubscribe.params
    this.send({ method: unsubscribe.method, params }, envelope)
  }

  private send(unsubscribe: StreamUnsubscribe, envelope: TEnvelope | undefined): void {
    this.options.sendFrame({ id: this.options.nextId(), ...unsubscribe, envelope })
  }

  private hasNewerSlotOwner(
    unsubscribe: StreamUnsubscribe,
    sendOrder: number,
    envelope: TEnvelope | undefined
  ): boolean {
    const slot = unsubscribeSlot(unsubscribe, envelope)
    if (slot === null) {
      return false
    }
    for (const [siblingId, sibling] of this.streams) {
      if (sibling.cancelled || sibling.sendOrder === null || sibling.sendOrder < sendOrder) {
        continue
      }
      const siblingUnsubscribe = this.paramsUnsubscribe(sibling.method, sibling.params, siblingId)
      if (siblingUnsubscribe && unsubscribeSlot(siblingUnsubscribe, sibling.envelope) === slot) {
        return true
      }
    }
    return false
  }

  private remove(id: string): void {
    const stream = this.streams.get(id)
    if (!stream) {
      return
    }
    this.options.onRemoved?.(id, stream)
    this.streams.delete(id)
    stream.listener = undefined
  }

  private fail(id: string, stream: RelayStream<TEnvelope>, message: string, error?: unknown): void {
    if (stream.cancelled || this.streams.get(id) !== stream) {
      return
    }
    this.finish(id, stream, { type: 'error', message, error })
  }

  /** Removed first, so the listener's dispose cannot name a host-ended stream. */
  private finish(id: string, stream: RelayStream<TEnvelope>, result: unknown): void {
    const listener = stream.listener
    this.remove(id)
    listener?.(result)
  }
}
