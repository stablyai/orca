import { closeRemoteRuntimeSocket } from '../remote-runtime-socket-close'
import { throwIfSignalAborted, abortSignalReason } from '../../abort-signal-reason'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { PairedRuntimeConnection } from '../../paired-runtime-connection'
import {
  createRemoteRuntimeClientHandshake,
  formatRemoteRuntimeCloseMessage,
  ignoreSettledRemoteRuntimeSocketError
} from '../../remote-runtime-client-handshake'
import { RemoteRuntimeClientError } from '../../remote-runtime-client-error'
import {
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from '../remote-runtime-connect-bound'
import {
  isRemoteRuntimeBinaryFrameWithinLimit,
  REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
  serializeRemoteRuntimeRpcRequest
} from '../../remote-runtime-memory-limits'
import { remoteRuntimeClientCapabilities } from '../../remote-runtime-client-capabilities'
import { RemoteRuntimeSubscriptionFrameRouter } from './remote-runtime-subscription-frame-router'
import { RemoteRuntimeSubscriptionOutbound } from './remote-runtime-subscription-outbound'
import { RemoteRuntimeSubscriptionRequestChannel } from './remote-runtime-subscription-request-channel'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessMonitor
} from '../../remote-runtime-socket-liveness'
import type {
  RemoteRuntimeSubscriptionOptions,
  RemoteRuntimeTransportSubscription,
  RemoteRuntimeTransportSubscriptionCallbacks
} from './remote-runtime-subscription-contract'

export async function subscribeRemoteRuntimeTransport<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: RemoteRuntimeTransportSubscriptionCallbacks<TResult>,
  options?: RemoteRuntimeSubscriptionOptions
): Promise<RemoteRuntimeTransportSubscription> {
  throwIfSignalAborted(options?.signal)
  const requestId = randomUUID()
  const serializedRequest = serializeRemoteRuntimeRpcRequest({
    requestId,
    deviceToken: connection.credential.deviceToken,
    method,
    params
  })
  return await new Promise((resolve, reject) => {
    const handshake = createRemoteRuntimeClientHandshake(connection.hostPublicKeyB64)
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
      connection,
      channel: handshake.channel,
      resolveWritableSocket: () =>
        frameRouter.state === 'ready' && ws && ws.readyState === WebSocket.OPEN ? ws : null,
      enqueue: (socket, frame) => outbound.enqueueRequest(socket, frame),
      fail: (error) => fail(error)
    })
    const frameRouter = new RemoteRuntimeSubscriptionFrameRouter({
      handshake,
      sealAuth: () =>
        handshake.sealAuth(
          { kind: 'token', deviceToken: connection.credential.deviceToken },
          { clientCapabilities: remoteRuntimeClientCapabilities(options?.clientCapabilities) }
        ),
      isSettled: () => terminalFailure || closing,
      serializedRequest,
      requestId,
      send: (frame) => ws?.send(frame),
      fail: (error) => fail(error),
      onAuthenticated: () => succeed(),
      resolvePendingRequest: (response) => requestChannel.resolveResponse(response),
      callbacks
    })

    const cleanupSocketListeners = (): WebSocket | null => {
      options?.signal?.removeEventListener('abort', onAbort)
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
      closeRemoteRuntimeSocket(cleanupSocketListeners())
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
      options?.signal?.removeEventListener('abort', onAbort)
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
      closeRemoteRuntimeSocket(ws)
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
      return outbound.enqueueBinary(ws, Buffer.from(handshake.channel.sealBinary(bytes)))
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

    const onAbort = (): void => {
      if (settled) {
        close()
      } else {
        settled = true
        clearTimeout(timeout)
        closeSocketAfterCleanup()
        reject(abortSignalReason(options!.signal!))
      }
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    if (options?.signal?.aborted) {
      onAbort()
      return
    }
    const connectOptions = remoteRuntimeConnectOptions(
      {
        maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
        ...(options?.perMessageDeflate === false ? { perMessageDeflate: false } : {})
      },
      options?.connectTimeoutMs
    )
    try {
      ws = new WebSocket(connection.endpoint, connectOptions)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail(new RemoteRuntimeClientError('invalid_argument', `Invalid remote endpoint: ${message}`))
      return
    }

    function onOpen(): void {
      ws?.send(handshake.helloText())
    }

    function onError(error: Error): void {
      fail(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          remoteRuntimeConnectFailureMessage(error, connection.endpoint)
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
        if (monitoredWs.readyState !== WebSocket.OPEN) {
          return false
        }
        monitoredWs.ping()
        return true
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
