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
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessMonitor,
  type RemoteRuntimeSocketLivenessOptions
} from './remote-runtime-socket-liveness'
import { createWsOutboundBackpressureQueue } from './ws-outbound-backpressure-queue'

export type RemoteRuntimeTransportSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
}

export type RemoteRuntimeTransportSubscriptionCallbacks<TResult = unknown> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

export async function subscribeRemoteRuntimeTransport<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: RemoteRuntimeTransportSubscriptionCallbacks<TResult>,
  livenessOptions?: RemoteRuntimeSocketLivenessOptions
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
    clientCapabilities: remoteRuntimeClientCapabilities()
  })
  return await new Promise((resolve, reject) => {
    const keyPair = generateKeyPair()
    const serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    const sharedKey = deriveSharedKey(keyPair.secretKey, serverPublicKey)
    let settled = false
    let ws: WebSocket | null = null
    let liveness: RemoteRuntimeSocketLivenessMonitor | null = null
    let sendQueue: ReturnType<typeof createWsOutboundBackpressureQueue<Buffer>> | null = null
    const frameRouter = new RemoteRuntimeSubscriptionFrameRouter({
      sharedKey,
      serializedAuth,
      serializedRequest,
      requestId,
      send: (frame) => ws?.send(frame),
      fail: (error) => fail(error),
      onAuthenticated: () => succeed(),
      callbacks
    })

    const cleanupSocketListeners = (): WebSocket | null => {
      liveness?.stop()
      liveness = null
      sendQueue?.dispose()
      sendQueue = null
      const socket = ws
      if (!socket) {
        return null
      }
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('message', onMessage)
      socket.off('pong', onLivenessSignal)
      socket.off('ping', onLivenessSignal)
      ws = null
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
      try {
        ws?.close()
      } catch {
        // ignore best-effort close
      }
    }

    const ensureSendQueue = (
      socket: WebSocket
    ): ReturnType<typeof createWsOutboundBackpressureQueue<Buffer>> => {
      if (!sendQueue) {
        sendQueue = createWsOutboundBackpressureQueue<Buffer>({
          send: (frame) => socket.send(frame, { binary: true }),
          byteLengthOf: (frame) => frame.byteLength,
          getBufferedAmount: () => socket.bufferedAmount,
          isWritable: () => socket.readyState === WebSocket.OPEN,
          onOverflow: () =>
            fail(
              new RemoteRuntimeClientError(
                'remote_runtime_unavailable',
                'Remote Orca runtime send buffer overflow; reconnecting.'
              )
            )
        })
      }
      return sendQueue
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
      ensureSendQueue(ws).enqueue(Buffer.from(encryptBytes(bytes, sharedKey)))
      return true
    }

    const succeed = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ requestId, close, sendBinary })
    }

    const fail = (error: RemoteRuntimeClientError): void => {
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
      ws = new WebSocket(pairing.endpoint, { maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES })
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
      options: livenessOptions
    })
  })
}
