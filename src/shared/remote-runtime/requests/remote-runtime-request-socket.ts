import WebSocket from 'ws'
import { abortSignalReason, throwIfSignalAborted } from '../../abort-signal-reason'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import type { RuntimeCapability } from '../../protocol-version'
import { remoteRuntimeClientCapabilities } from '../remote-runtime-client-capabilities'
import {
  formatRemoteRuntimeCloseMessage,
  ignoreSettledRemoteRuntimeSocketError
} from '../remote-runtime-client-handshake'
import {
  withRemoteRuntimeFramingFallback,
  type RemoteRuntimeClientHandshake
} from '../remote-runtime-client-framing'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import {
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from '../remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../remote-runtime-memory-limits'
import {
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import { readSealedFrame } from '../remote-runtime-sealed-frame'
import { RemoteRuntimeRequestResponseRouter } from './remote-runtime-request-response-router'
import {
  prepareRuntimeSocketRequest,
  prepareCurrentRuntimeRequest
} from './remote-runtime-request-preparation'
import type {
  RuntimeRequestPreparation,
  RuntimeRequestGuard,
  RuntimeRequestSelection,
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../runtime-rpc-envelope'
import type { RuntimeStatus } from '../../runtime-session-contracts'
import { isSafeTimerDelayMs, MAX_TIMER_DELAY_MS } from '../../timer-delay'

export async function sendRemoteRuntimeRequestOnSocket<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  validateStatus?: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = [],
  requestSelection?: RuntimeRequestSelection,
  prepareRequest?: RuntimeRequestPreparation,
  // Internal: the framing fallback's legacy status check on a latched host uses exactly this dial.
  latchedHostCheck?: RemoteRuntimeClientHandshake,
  prepareGuard?: RuntimeRequestGuard
): Promise<RuntimeRpcResponse<TResult>> {
  throwIfSignalAborted(signal)
  if (!isSafeTimerDelayMs(timeoutMs)) {
    throw new RemoteRuntimeClientError(
      'invalid_argument',
      `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
    )
  }
  const { requestId, statusRequestId, serializedStatusRequest, prepare, pendingRequest } =
    prepareRuntimeSocketRequest(
      connection,
      method,
      params,
      envelope,
      prepareRequest,
      Boolean(validateStatus),
      Boolean(requestSelection)
    )
  // Why a redial is safe: nothing but the handshake is sent before the host authenticates us.
  const attempt = (handshake: RemoteRuntimeClientHandshake) =>
    new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
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

      let deadline = performance.now() + timeoutMs
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
        deadline = performance.now() + timeoutMs
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

      let preparingSend = false
      function sendRequestedRpc(status?: unknown): void {
        if (settled || preparingSend) {
          return
        }
        preparingSend = true
        void sendPreparedRpc(status).catch((error: unknown) =>
          finishError(error instanceof Error ? error : new Error(String(error)))
        )
      }

      async function sendPreparedRpc(status?: unknown): Promise<void> {
        try {
          if (requestSelection) {
            const selectedParams = requestSelection.paramsForStatus(status)
            releaseRemoteRuntimePreparedRequest(pendingRequest)
            pendingRequest.preparedRequest = prepare(selectedParams)
          }
          await prepareCurrentRuntimeRequest({
            connection,
            guard: prepareGuard,
            current: () => !settled && !signal?.aborted && ws?.readyState === WebSocket.OPEN,
            deadline,
            expire: onTimeout,
            consume: () => {
              const request = takeRemoteRuntimePreparedRequest(pendingRequest)
              if (request === null) {
                throw new RemoteRuntimeClientError(
                  'remote_runtime_unavailable',
                  'Remote Orca runtime request was released before it could be sent.'
                )
              }
              const frame = handshake.channel.sealText(request)
              requestSelection?.onDispatch?.()
              ws?.send(frame)
            }
          })
        } catch (error) {
          finishError(error instanceof Error ? error : new Error(String(error)))
        }
      }

      router = new RemoteRuntimeRequestResponseRouter({
        handshake,
        sealAuth: () =>
          handshake.sealAuth(
            { kind: 'token', deviceToken: connection.credential.deviceToken },
            { clientCapabilities: remoteRuntimeClientCapabilities(clientCapabilities) }
          ),
        isSettled: () => settled,
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

      const dial = (): void => {
        if (settled || signal?.aborted) {
          return
        }
        try {
          const connectOptions = remoteRuntimeConnectOptions({
            maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES
          })
          ws = new WebSocket(connection.endpoint, connectOptions)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          finishError(
            new RemoteRuntimeClientError('invalid_argument', `Invalid remote endpoint: ${message}`)
          )
          return
        }
        ws!.once('open', onOpen)
        ws!.once('error', onError)
        ws!.on('close', onClose)
        ws!.on('message', onMessage)
      }
      if (prepareGuard) {
        const prepareDial = (): Promise<void> =>
          prepareCurrentRuntimeRequest({
            connection,
            guard: prepareGuard,
            current: () => !settled && !signal?.aborted,
            deadline,
            expire: onTimeout,
            consume: dial
          })
        void prepareDial().catch((error: unknown) =>
          finishError(error instanceof Error ? error : new Error(String(error)))
        )
      } else {
        dial()
      }

      function onOpen(): void {
        ws?.send(handshake.helloText())
      }

      function onError(error: Error): void {
        finishError(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            remoteRuntimeConnectFailureMessage(error, connection.endpoint),
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
        router.handleFrame(readSealedFrame(data, isBinary))
      }
    })
  const dialed = latchedHostCheck
    ? attempt(latchedHostCheck)
    : withRemoteRuntimeFramingFallback(connection.hostPublicKeyB64, {
        attempt,
        signal,
        readStatus: (handshake) =>
          sendRemoteRuntimeRequestOnSocket<RuntimeStatus>(
            connection,
            'status.get',
            undefined,
            timeoutMs,
            undefined,
            undefined,
            signal,
            clientCapabilities,
            undefined,
            undefined,
            handshake
          )
      })
  return await dialed.finally(() => releaseRemoteRuntimePreparedRequest(pendingRequest))
}
