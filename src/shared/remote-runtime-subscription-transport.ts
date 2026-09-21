import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import {
  deriveSharedKey,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import type { RuntimeCapability } from './protocol-version'
import {
  formatRemoteRuntimeCloseMessage,
  ignoreSettledRemoteRuntimeSocketError
} from './remote-runtime-client-handshake'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  isRemoteRuntimeBinaryFrameWithinLimit,
  REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
  serializeRemoteRuntimePayload,
  serializeRemoteRuntimeRpcRequest
} from './remote-runtime-memory-limits'
import { remoteRuntimeClientCapabilities } from './remote-runtime-client-capabilities'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import { RemoteRuntimeSubscriptionFrameRouter } from './remote-runtime-subscription-frame-router'
import {
  RemoteRuntimeSubscriptionOutbound,
  type RemoteRuntimeOutboundMemoryBudget,
  type RemoteRuntimeOutboundQueueOptions
} from './remote-runtime-subscription-outbound'
import { RemoteRuntimeSubscriptionRequestChannel } from './remote-runtime-subscription-request-channel'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessMonitor,
  type RemoteRuntimeSocketLivenessOptions
} from './remote-runtime-socket-liveness'

export type {
  RemoteRuntimeOutboundMemoryBudget,
  RemoteRuntimeOutboundSocketMemory
} from './remote-runtime-subscription-outbound'

export type RemoteRuntimeTransportSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  sendRequest?: (
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
}

export type RemoteRuntimeTransportSubscriptionCallbacks<TResult = unknown> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

export type RemoteRuntimeSubscriptionOptions = RemoteRuntimeSocketLivenessOptions & {
  clientCapabilities?: readonly RuntimeCapability[]
  perMessageDeflate?: boolean
  outboundQueue?: RemoteRuntimeOutboundQueueOptions
  outboundMemoryBudget?: RemoteRuntimeOutboundMemoryBudget
}

export async function subscribeRemoteRuntimeTransport<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: RemoteRuntimeTransportSubscriptionCallbacks<TResult>,
  options?: RemoteRuntimeSubscriptionOptions
): Promise<RemoteRuntimeTransportSubscription> {
  const requestId = randomUUID()
  const serializedRequest = serializeRemoteRuntimeRpcRequest({
    requestId,
    deviceToken: pairing.deviceToken,
    method,
    params
  })
  const serializedAuth = serializeRemoteRuntimePayload({
    type: 'e2ee_auth',
    deviceToken: pairing.deviceToken,
    clientCapabilities: remoteRuntimeClientCapabilities(options?.clientCapabilities)
  })
  return await new Promise((resolve, reject) => {
    const keyPair = generateKeyPair()
    const serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    const sharedKey = deriveSharedKey(keyPair.secretKey, serverPublicKey)
    let settled = false
    let closing = false
    let terminalFailure = false
    let ws: WebSocket | null = null
    let liveness: RemoteRuntimeSocketLivenessMonitor | null = null
    const outbound = new RemoteRuntimeSubscriptionOutbound({
      memoryBudget: options?.outboundMemoryBudget,
      binaryQueue: options?.outboundQueue,
      fail: (error) => fail(error)
    })
    const requestChannel = new RemoteRuntimeSubscriptionRequestChannel({
      pairing,
      sharedKey,
      resolveWritableSocket: () =>
        frameRouter.state === 'ready' && ws && ws.readyState === WebSocket.OPEN ? ws : null,
      enqueue: (socket, frame) => outbound.enqueueRequest(socket, frame),
      fail: (error) => fail(error)
    })
    const frameRouter = new RemoteRuntimeSubscriptionFrameRouter({
      sharedKey,
      serializedAuth,
      serializedRequest,
      requestId,
      send: (frame) => ws?.send(frame),
      fail: (error) => fail(error),
      onAuthenticated: () => succeed(),
      resolvePendingRequest: (response) => requestChannel.resolveResponse(response),
      callbacks
    })

    const cleanupSocketListeners = (): WebSocket | null => {
      liveness?.stop()
      liveness = null
      outbound.releaseQueues()
      const socket = ws
      if (!socket) {
        if (!outbound.hasRetainedCloseSource) {
          outbound.releaseSocketMemory()
        }
        return null
      }
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('message', onMessage)
      socket.off('pong', onLivenessSignal)
      socket.off('ping', onLivenessSignal)
      ws = null
      outbound.retainSocketMemoryUntilClose(socket)
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.on('error', ignoreSettledRemoteRuntimeSocketError)
      }
      return socket
    }

    const closeSocketAfterCleanup = (): void => {
      const socket = cleanupSocketListeners()
      try {
        socket?.close()
      } catch {
        // ignore best-effort close
      }
    }

    const timeout = setTimeout(() => {
      fail(
        new RemoteRuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the remote Orca runtime subscription to start.'
        )
      )
    }, timeoutMs)

    const close = (): void => {
      if (closing) {
        return
      }
      closing = true
      requestChannel.rejectAll(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'Remote runtime subscription closed before its request completed.'
        )
      )
      outbound.releaseQueues()
      if (ws) {
        outbound.retainSocketMemoryUntilClose(ws)
      } else if (!outbound.hasRetainedCloseSource) {
        outbound.releaseSocketMemory()
      }
      try {
        ws?.close()
      } catch {
        // ignore best-effort close
      }
    }

    const sendBinary = (bytes: Uint8Array<ArrayBufferLike>): boolean => {
      if (
        !isRemoteRuntimeBinaryFrameWithinLimit(bytes) ||
        frameRouter.state !== 'ready' ||
        !ws ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return false
      }
      return outbound.enqueueBinary(ws, Buffer.from(encryptBytes(bytes, sharedKey)))
    }

    const succeed = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ requestId, close, sendBinary, sendRequest: requestChannel.send })
    }

    const fail = (error: RemoteRuntimeClientError): void => {
      if (terminalFailure || closing) {
        return
      }
      terminalFailure = true
      requestChannel.rejectAll(error)
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        closeSocketAfterCleanup()
        reject(error)
        return
      }
      callbacks.onError(error)
      closeSocketAfterCleanup()
      callbacks.onClose?.()
    }

    try {
      ws = new WebSocket(pairing.endpoint, {
        maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
        ...(options?.perMessageDeflate === false ? { perMessageDeflate: false } : {})
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail(new RemoteRuntimeClientError('invalid_argument', `Invalid remote endpoint: ${message}`))
      return
    }

    function onOpen(): void {
      ws?.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(keyPair.publicKey) })
      )
    }

    function onError(): void {
      fail(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'Could not connect to the remote Orca runtime.'
        )
      )
    }

    function onClose(code: number, reason: Buffer): void {
      clearTimeout(timeout)
      cleanupSocketListeners()
      requestChannel.rejectAll(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          formatRemoteRuntimeCloseMessage(code, reason)
        )
      )
      if (!settled) {
        settled = true
        reject(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            formatRemoteRuntimeCloseMessage(code, reason)
          )
        )
        return
      }
      callbacks.onClose?.()
    }

    function onMessage(data: WebSocket.RawData, isBinary: boolean): void {
      if (closing) {
        return
      }
      liveness?.noteActivity()
      frameRouter.handleFrame(data, isBinary)
    }

    function onLivenessSignal(): void {
      liveness?.noteActivity()
    }

    ws.once('open', onOpen)
    ws.once('error', onError)
    ws.on('close', onClose)
    ws.on('message', onMessage)
    ws.on('pong', onLivenessSignal)
    ws.on('ping', onLivenessSignal)

    const monitoredWs = ws
    liveness = startRemoteRuntimeSocketLiveness({
      ping: () => {
        if (monitoredWs.readyState === WebSocket.OPEN) {
          monitoredWs.ping()
        }
      },
      onDead: () => {
        fail(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote Orca runtime stopped responding; the stream connection was reset.'
          )
        )
        try {
          monitoredWs.terminate()
        } catch {
          // Best-effort terminate; the subscription is already settled.
        }
      },
      options
    })
  })
}
