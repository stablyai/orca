import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { abortSignalReason, throwIfSignalAborted } from './abort-signal-reason'
import {
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import type { PairingOffer } from './pairing'
import { remoteRuntimeClientCapabilities } from './remote-runtime-client-capabilities'
import {
  formatRemoteRuntimeCloseMessage,
  ignoreSettledRemoteRuntimeSocketError
} from './remote-runtime-client-handshake'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
  serializeRemoteRuntimePayload,
  serializeRemoteRuntimeRpcRequest
} from './remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import { RemoteRuntimeRequestResponseRouter } from './remote-runtime-request-response-router'
import {
  subscribeRemoteRuntimeTransport,
  type RemoteRuntimeTransportSubscriptionCallbacks
} from './remote-runtime-subscription-transport'
import type { RemoteRuntimeSocketLivenessOptions } from './remote-runtime-socket-liveness'
import type { RuntimeOrchestrationEnvelope, RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RuntimeStatus } from './runtime-types'
import { isSafeTimerDelayMs, MAX_TIMER_DELAY_MS } from './timer-delay'

export { RemoteRuntimeClientError } from './remote-runtime-client-error'

export type RemoteRuntimeSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
}

export type RemoteRuntimeSubscriptionCallbacks<TResult = unknown> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

export function sendRemoteRuntimeRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(
    pairing,
    method,
    params,
    timeoutMs,
    envelope,
    undefined,
    signal
  )
}

export function sendRemoteRuntimeRequestWithStatusPreflight<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  validateStatus: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(
    pairing,
    method,
    params,
    timeoutMs,
    envelope,
    validateStatus
  )
}

async function sendRemoteRuntimeRequestOnSocket<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  validateStatus?: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<TResult>> {
  throwIfSignalAborted(signal)
  if (!isSafeTimerDelayMs(timeoutMs)) {
    throw new RemoteRuntimeClientError(
      'invalid_argument',
      `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
    )
  }
  const requestId = randomUUID()
  const statusRequestId = validateStatus ? randomUUID() : null
  const serializedStatusRequest = statusRequestId
    ? serializeRemoteRuntimePayload({
        id: statusRequestId,
        deviceToken: pairing.deviceToken,
        method: 'status.get'
      })
    : null
  const serializedAuth = serializeRemoteRuntimePayload({
    type: 'e2ee_auth',
    deviceToken: pairing.deviceToken,
    clientCapabilities: remoteRuntimeClientCapabilities()
  })
  const pendingRequest = {
    preparedRequest: prepareRemoteRuntimeRequest(new Map(), () =>
      serializeRemoteRuntimeRpcRequest({
        requestId,
        deviceToken: pairing.deviceToken,
        method,
        params,
        envelope
      })
    )
  }
  let serializedRequest = takeRemoteRuntimePreparedRequest(pendingRequest)
  return await new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
    const keyPair = generateKeyPair()
    const sharedKey = deriveSharedKey(keyPair.secretKey, publicKeyFromBase64(pairing.publicKeyB64))
    let settled = false
    let ws: WebSocket | null = null
    let router: RemoteRuntimeRequestResponseRouter<TResult>

    const cleanupSocketListeners = (): void => {
      signal?.removeEventListener('abort', onAbort)
      const socket = ws
      if (!socket) {
        return
      }
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('message', onMessage)
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.on('error', ignoreSettledRemoteRuntimeSocketError)
      }
    }

    let timeout = setTimeout(onTimeout, timeoutMs)

    function onTimeout(): void {
      finishError(
        new RemoteRuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the remote Orca runtime to respond.',
          { pairingStage: router.pairingStage }
        )
      )
    }

    function onAbort(): void {
      finishError(abortSignalReason(signal!))
    }

    function refreshTimeout(): void {
      const refreshableTimeout = timeout as { refresh?: () => void }
      if (typeof refreshableTimeout.refresh === 'function') {
        refreshableTimeout.refresh()
        return
      }
      clearTimeout(timeout)
      timeout = setTimeout(onTimeout, timeoutMs)
    }

    const finish = (
      result: { ok: true; response: RuntimeRpcResponse<TResult> } | { ok: false; error: Error }
    ): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      try {
        cleanupSocketListeners()
        ws?.close()
      } catch {
        // ignore best-effort close
      }
      if (result.ok === false) {
        reject(result.error)
      } else {
        resolve(result.response)
      }
    }

    const finishError = (error: Error): void => finish({ ok: false, error })
    const finishResponse = (response: RuntimeRpcResponse<TResult>): void =>
      finish({ ok: true, response })

    function sendRequestedRpc(): void {
      const request = serializedRequest
      serializedRequest = null
      if (request === null) {
        finishError(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote Orca runtime request was released before it could be sent.'
          )
        )
        return
      }
      ws?.send(encrypt(request, sharedKey))
    }

    router = new RemoteRuntimeRequestResponseRouter({
      sharedKey,
      serializedAuth,
      serializedStatusRequest,
      requestId,
      statusRequestId,
      validateStatus,
      send: (frame) => ws?.send(frame),
      sendRequestedRpc,
      refreshTimeout,
      finishError,
      finishResponse
    })

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    try {
      ws = new WebSocket(pairing.endpoint, { maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finishError(
        new RemoteRuntimeClientError('invalid_argument', `Invalid remote endpoint: ${message}`)
      )
      return
    }

    function onOpen(): void {
      ws?.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: publicKeyToBase64(keyPair.publicKey)
        })
      )
    }

    function onError(): void {
      finishError(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'Could not connect to the remote Orca runtime.',
          { pairingStage: router.pairingStage }
        )
      )
    }

    function onClose(code: number, reason: Buffer): void {
      if (!settled) {
        finishError(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            formatRemoteRuntimeCloseMessage(code, reason),
            { pairingStage: router.pairingStage, closeCode: code }
          )
        )
      }
    }

    function onMessage(data: WebSocket.RawData, isBinary: boolean): void {
      if (settled) {
        return
      }
      if (isBinary) {
        finishError(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an unexpected binary frame.',
            {
              pairingStage:
                router.state === 'awaiting_ready' ? 'host-identity' : router.pairingStage
            }
          )
        )
        return
      }
      router.handleTextFrame(data.toString())
    }

    ws.once('open', onOpen)
    ws.once('error', onError)
    ws.on('close', onClose)
    ws.on('message', onMessage)
  }).finally(() => releaseRemoteRuntimePreparedRequest(pendingRequest))
}

export function subscribeRemoteRuntimeRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: RemoteRuntimeSubscriptionCallbacks<TResult>,
  livenessOptions?: RemoteRuntimeSocketLivenessOptions
): Promise<RemoteRuntimeSubscription> {
  return subscribeRemoteRuntimeTransport(
    pairing,
    method,
    params,
    timeoutMs,
    callbacks as RemoteRuntimeTransportSubscriptionCallbacks<TResult>,
    livenessOptions
  )
}
