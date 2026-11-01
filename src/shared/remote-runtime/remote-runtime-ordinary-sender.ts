import type WebSocket from 'ws'
import type { PairedE2EEClientHandshake } from '../paired-e2ee-client-handshake'
import type { RuntimeRpcResponse } from '../runtime-rpc-envelope'
import { RUNTIME_ORDINARY_MESSAGE_CAPABILITY } from '../runtime-ordinary-message-capability'
import {
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES,
  serializeRemoteRuntimePayload
} from './remote-runtime-memory-limits'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { RemoteRuntimeSubscriptionOutbound } from './requests/remote-runtime-subscription-outbound'
import { remoteRuntimeOutboundAdmission } from './remote-runtime-outbound-admission'

/** The connection's ordinary capacity proof and existing physical queue share its socket lifetime. */
export class RemoteRuntimeOrdinarySender {
  private supported: boolean | undefined
  private socket: WebSocket | null = null
  private outbound: RemoteRuntimeSubscriptionOutbound | null = null
  open(socket: WebSocket, fail: (error: Error) => void): void {
    this.socket = socket
    this.outbound = new RemoteRuntimeSubscriptionOutbound({
      memoryBudget: remoteRuntimeOutboundAdmission,
      fail
    })
  }
  observe<T>(
    method: string,
    response: RuntimeRpcResponse<T>,
    current: boolean
  ): RuntimeRpcResponse<T> {
    if (
      method === 'status.get' &&
      current &&
      response.ok &&
      typeof response.result === 'object' &&
      response.result !== null &&
      'capabilities' in response.result &&
      Array.isArray(response.result.capabilities)
    ) {
      this.supported = response.result.capabilities.includes(RUNTIME_ORDINARY_MESSAGE_CAPABILITY)
    }
    return response
  }
  admit(
    json: string,
    socket: WebSocket | null,
    probe: () => Promise<unknown>,
    pending: () => boolean
  ): boolean | Promise<boolean> {
    if (Buffer.byteLength(json) <= REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES) {
      return true
    }
    const complete = () => {
      if (!pending()) {
        return false
      }
      if (this.socket !== socket || !this.supported) {
        throw new RemoteRuntimeClientError(
          'invalid_argument',
          'This connection cannot carry a request this large.'
        )
      }
      return true
    }
    return this.supported === undefined ? probe().then(complete) : complete()
  }
  send(
    json: string,
    socket: WebSocket | null,
    handshake: PairedE2EEClientHandshake | null,
    ready: boolean
  ): boolean {
    if (!ready || !socket || socket !== this.socket || socket.readyState !== 1 || !handshake) {
      return false
    }
    return this.outbound?.enqueueRequest(socket, handshake.channel.sealText(json)) ?? false
  }
  sendValue(
    value: unknown,
    socket: WebSocket | null,
    handshake: PairedE2EEClientHandshake | null,
    state: string
  ): boolean {
    try {
      return this.send(
        serializeRemoteRuntimePayload(value),
        socket,
        handshake,
        state === 'ready' || state === 'awaiting_authenticated'
      )
    } catch {
      return false
    }
  }
  observer(method: string, generation: { peek: () => number }) {
    const source = generation.peek()
    return (response: RuntimeRpcResponse<unknown>) => {
      this.observe(method, response, source === generation.peek())
    }
  }
  close(): void {
    this.supported = undefined
    const outbound = this.outbound
    this.outbound = null
    outbound?.releaseQueues()
    if (this.socket) {
      outbound?.retainSocketMemoryUntilClose(this.socket)
    }
    this.socket = null
  }
}
