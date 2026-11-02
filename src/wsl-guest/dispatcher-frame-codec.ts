import {
  HEADER_LENGTH,
  MessageType,
  encodePreparedJsonRpcFrame,
  parseJsonRpcMessage,
  prepareJsonRpcPayload,
  type DecodedFrame,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './protocol'
import type { DispatcherWriterLane, SinkWriteSettlement } from './dispatcher-client-writer'
import type { OutgoingJsonRpcMessage, PreparedRelayFrame, RelayClient } from './dispatcher-contract'
import { RelayDispatcherCapacitySignals } from './dispatcher-capacity-signals'

export abstract class RelayDispatcherFrameCodec extends RelayDispatcherCapacitySignals {
  protected handleFrame(client: RelayClient, frame: DecodedFrame): void {
    // Before the KeepAlive early return: a keepalive is the only proof a quiet client is still there.
    client.lastReceivedAt = Date.now()
    if (frame.id > client.highestReceivedSeq) {
      client.highestReceivedSeq = frame.id
    }

    if (frame.type === MessageType.KeepAlive) {
      client.keepaliveObserved = true
      return
    }

    if (frame.type === MessageType.Regular) {
      try {
        const msg = parseJsonRpcMessage(frame.payload)
        this.handleMessage(client, msg)
      } catch (err) {
        process.stderr.write(
          `[relay] Parse error: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  protected prepareFrame(msg: OutgoingJsonRpcMessage): PreparedRelayFrame {
    const payload = prepareJsonRpcPayload(msg)
    const params = 'method' in msg && msg.method === 'pty.data' ? (msg.params ?? {}) : null
    return Object.freeze({
      payload,
      frameBytes: HEADER_LENGTH + payload.byteLength,
      ptyDataAdmissionParams:
        params === null
          ? null
          : Object.freeze({
              id: params.id,
              deliveryToken: params.deliveryToken,
              clientGeneration: params.clientGeneration,
              ownerGeneration: params.ownerGeneration,
              ptyIncarnation: params.ptyIncarnation
            })
    })
  }

  protected estimateFrameBytes(msg: OutgoingJsonRpcMessage): number {
    return HEADER_LENGTH + prepareJsonRpcPayload(msg).byteLength
  }

  protected enqueueFrame(
    client: RelayClient,
    msg: OutgoingJsonRpcMessage,
    lane: DispatcherWriterLane,
    onSettled: (result: SinkWriteSettlement) => void = () => {},
    controlOverflow: 'close-client' | 'reject' = 'close-client'
  ): boolean {
    if (this.disposed || client.closed) {
      return false
    }
    return this.enqueuePreparedFrame(
      client,
      this.prepareFrame(msg),
      lane,
      onSettled,
      controlOverflow
    )
  }

  protected enqueuePreparedFrame(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: DispatcherWriterLane,
    onSettled: (result: SinkWriteSettlement) => void = () => {},
    controlOverflow: 'close-client' | 'reject' = 'close-client'
  ): boolean {
    if (this.disposed || client.closed) {
      return false
    }
    const encode = (): Buffer => {
      const seq = client.nextOutgoingSeq++
      return encodePreparedJsonRpcFrame(frame.payload, seq, client.highestReceivedSeq)
    }
    const admissionParams = frame.ptyDataAdmissionParams
    const isStillAdmitted = admissionParams
      ? () => this.admitsPtyDataPublication(client.id, admissionParams)
      : undefined
    return client.writer.enqueue(
      lane,
      encode,
      frame.frameBytes,
      onSettled,
      lane === 'control' && controlOverflow === 'reject',
      isStillAdmitted
    )
  }

  private handleMessage(
    client: RelayClient,
    msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
  ): void {
    if ('id' in msg && 'method' in msg) {
      void this.handleRequest(client, msg as JsonRpcRequest)
    } else if ('id' in msg && ('result' in msg || 'error' in msg)) {
      this.handleResponse(msg as JsonRpcResponse)
    } else if ('method' in msg && !('id' in msg)) {
      this.handleNotification(client, msg as JsonRpcNotification)
    }
  }
}
