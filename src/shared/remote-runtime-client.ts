/* oxlint-disable max-lines -- Why: one-shot and streaming remote clients share the
 * same E2EE handshake and response validation state; keep them together until
 * the terminal transport is fully migrated and a stable shared connection
 * abstraction emerges. */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import {
  isKeepaliveFrame,
  RuntimeRpcEnvelopeSchema,
  type RuntimeOrchestrationEnvelope,
  type RuntimeRpcResponse
} from './runtime-rpc-envelope'
import type { RuntimeStatus } from './runtime-types'
import {
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from './protocol-version'
// Re-export so existing value importers of `RemoteRuntimeClientError` are
// unaffected; the class lives in a ws-free module so type-only consumers
// (and mobile's typecheck) don't compile this file's Node-only deps.
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  isRemoteRuntimeBinaryFrameWithinLimit,
  REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
  serializeRemoteRuntimePayload,
  serializeRemoteRuntimeRpcRequest
} from './remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import { parseRemoteRuntimeJsonText } from './remote-runtime-request-frames'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessMonitor,
  type RemoteRuntimeSocketLivenessOptions
} from './remote-runtime-socket-liveness'
import { createWsOutboundBackpressureQueue } from './ws-outbound-backpressure-queue'
import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from './timer-delay'

export { RemoteRuntimeClientError } from './remote-runtime-client-error'

type HandshakeState = 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

function ignoreSettledRemoteRuntimeSocketError(): void {}

function formatRemoteRuntimeCloseMessage(code: number, reason: Buffer): string {
  const suffixParts: string[] = []
  if (code !== 1005 && code !== 1006) {
    suffixParts.push(String(code))
  }
  const reasonText = reason.toString().trim()
  if (reasonText) {
    suffixParts.push(reasonText)
  }
  return suffixParts.length > 0
    ? `Remote Orca runtime closed the connection (${suffixParts.join(': ')}).`
    : 'Remote Orca runtime closed the connection.'
}

export type RemoteRuntimeSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  sendRequest?: (
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
}

export type RemoteRuntimeSubscriptionCallbacks<TResult = unknown> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

export type RemoteRuntimeSubscriptionOptions = RemoteRuntimeSocketLivenessOptions & {
  clientCapabilities?: readonly RuntimeCapability[]
  perMessageDeflate?: boolean
  outboundQueue?: {
    softCapBytes: number
    maxQueuedBytes: number
    maxQueuedFrames: number
    maxDrainFramesPerTurn?: number
  }
  outboundMemoryBudget?: RemoteRuntimeOutboundMemoryBudget
}

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

type PendingRemoteRuntimeSubscriptionRequest = {
  resolve: (response: RuntimeRpcResponse<unknown>) => void
  reject: (error: RemoteRuntimeClientError) => void
  timeout: ReturnType<typeof setTimeout>
}

const MAX_PENDING_SUBSCRIPTION_REQUESTS = 32
const SUBSCRIPTION_REQUEST_SOFT_CAP_BYTES = 1024 * 1024
const SUBSCRIPTION_REQUEST_MAX_QUEUED_BYTES = 16 * 1024 * 1024
const SUBSCRIPTION_REQUEST_MAX_QUEUED_FRAMES = 64

export function sendRemoteRuntimeRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(pairing, method, params, timeoutMs, envelope)
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
  validateStatus?: (response: RuntimeRpcResponse<RuntimeStatus>) => void
): Promise<RuntimeRpcResponse<TResult>> {
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
    clientCapabilities: [
      SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
      AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
      WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
      WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
    ]
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
  let awaitingRequestId = statusRequestId ?? requestId
  let awaitingStatus = statusRequestId !== null
  return await new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
    const keyPair = generateKeyPair()
    const serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    const sharedKey = deriveSharedKey(keyPair.secretKey, serverPublicKey)
    let state: HandshakeState = 'awaiting_ready'
    let settled = false
    let ws: WebSocket | null = null
    const getPairingStage = (): 'connect' | 'host-identity' | 'runtime' =>
      state === 'awaiting_ready'
        ? 'connect'
        : state === 'awaiting_authenticated'
          ? 'host-identity'
          : 'runtime'

    const cleanupSocketListeners = (): void => {
      const socket = ws
      if (!socket) {
        return
      }
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('message', onMessage)
      // Why: the settled one-shot no longer needs Orca callbacks, but a ws
      // can still report a late transport error after close is requested.
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.on('error', ignoreSettledRemoteRuntimeSocketError)
      }
    }

    let timeout = setTimeout(onTimeout, timeoutMs)

    function onTimeout(): void {
      finish({
        ok: false,
        error: new RemoteRuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the remote Orca runtime to respond.',
          { pairingStage: getPairingStage() }
        )
      })
    }

    function refreshTimeout(): void {
      const refreshableTimeout = timeout as { refresh?: () => void }
      if (typeof refreshableTimeout.refresh === 'function') {
        refreshableTimeout.refresh()
        return
      }
      // Mobile's DOM timer type has no refresh().
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

    try {
      ws = new WebSocket(pairing.endpoint, { maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finish({
        ok: false,
        error: new RemoteRuntimeClientError(
          'invalid_argument',
          `Invalid remote endpoint: ${message}`
        )
      })
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
      finish({
        ok: false,
        error: new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'Could not connect to the remote Orca runtime.',
          { pairingStage: getPairingStage() }
        )
      })
    }

    function onClose(code: number, reason: Buffer): void {
      if (!settled) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            formatRemoteRuntimeCloseMessage(code, reason),
            {
              pairingStage: getPairingStage(),
              closeCode: code
            }
          )
        })
      }
    }

    function onMessage(data: WebSocket.RawData, isBinary: boolean): void {
      if (settled) {
        return
      }
      if (isBinary) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an unexpected binary frame.',
            {
              pairingStage: state === 'awaiting_ready' ? 'host-identity' : getPairingStage()
            }
          )
        })
        return
      }

      const frame = data.toString()
      if (state === 'awaiting_ready') {
        handleReadyFrame(frame)
        return
      }

      const plaintext = decrypt(frame, sharedKey)
      if (plaintext === null) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an undecryptable frame.',
            {
              pairingStage: state === 'awaiting_authenticated' ? 'host-identity' : getPairingStage()
            }
          )
        })
        return
      }

      if (state === 'awaiting_authenticated') {
        handleAuthenticatedFrame(plaintext)
        return
      }

      handleRpcFrame(plaintext)
    }

    ws.once('open', onOpen)
    ws.once('error', onError)
    ws.on('close', onClose)
    ws.on('message', onMessage)

    function handleReadyFrame(frame: string): void {
      let ready: unknown
      try {
        ready = parseRemoteRuntimeJsonText(frame)
      } catch {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid E2EE handshake frame.',
            { pairingStage: 'host-identity' }
          )
        })
        return
      }
      if (
        typeof ready !== 'object' ||
        ready === null ||
        (ready as { type?: unknown }).type !== 'e2ee_ready'
      ) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an unexpected E2EE handshake frame.',
            { pairingStage: 'host-identity' }
          )
        })
        return
      }
      state = 'awaiting_authenticated'
      ws?.send(encrypt(serializedAuth, sharedKey))
    }

    function handleAuthenticatedFrame(plaintext: string): void {
      let authenticated: unknown
      try {
        authenticated = parseRemoteRuntimeJsonText(plaintext)
      } catch {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid E2EE auth frame.',
            { pairingStage: 'host-identity' }
          )
        })
        return
      }
      const type = (authenticated as { type?: unknown }).type
      if (type !== 'e2ee_authenticated') {
        const code =
          typeof authenticated === 'object' &&
          authenticated !== null &&
          (authenticated as { error?: { code?: unknown } }).error?.code === 'unauthorized'
            ? 'unauthorized'
            : 'invalid_runtime_response'
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            code,
            'Remote Orca runtime rejected the pairing token.',
            { pairingStage: code === 'unauthorized' ? 'access-grant' : 'host-identity' }
          )
        })
        return
      }
      state = 'ready'
      if (serializedStatusRequest) {
        ws?.send(encrypt(serializedStatusRequest, sharedKey))
        return
      }
      sendRequestedRpc()
    }

    function sendRequestedRpc(): void {
      const request = serializedRequest
      serializedRequest = null
      if (request === null) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote Orca runtime request was released before it could be sent.'
          )
        })
        return
      }
      ws?.send(encrypt(request, sharedKey))
    }

    function handleRpcFrame(plaintext: string): void {
      let raw: unknown
      try {
        raw = parseRemoteRuntimeJsonText(plaintext)
      } catch {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid response frame.',
            { pairingStage: 'runtime' }
          )
        })
        return
      }
      if (isKeepaliveFrame(raw)) {
        refreshTimeout()
        return
      }
      const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
      if (!parsed.success || '_keepalive' in parsed.data) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid response frame.',
            { pairingStage: 'runtime' }
          )
        })
        return
      }
      if (parsed.data.id !== awaitingRequestId) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned a mismatched response id.',
            { pairingStage: 'runtime' }
          )
        })
        return
      }
      if (awaitingStatus && validateStatus) {
        try {
          validateStatus(parsed.data as RuntimeRpcResponse<RuntimeStatus>)
        } catch (error) {
          finish({
            ok: false,
            error:
              error instanceof Error
                ? error
                : new RemoteRuntimeClientError('runtime_error', String(error))
          })
          return
        }
        awaitingStatus = false
        awaitingRequestId = requestId
        refreshTimeout()
        sendRequestedRpc()
        return
      }
      const response = parsed.data as RuntimeRpcResponse<TResult>
      finish({ ok: true, response })
    }
  }).finally(() => releaseRemoteRuntimePreparedRequest(pendingRequest))
}

export async function subscribeRemoteRuntimeRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: RemoteRuntimeSubscriptionCallbacks<TResult>,
  options?: RemoteRuntimeSubscriptionOptions
): Promise<RemoteRuntimeSubscription> {
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
    clientCapabilities: Array.from(
      new Set([
        SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
        AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
        WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
        WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
        ...(options?.clientCapabilities ?? [])
      ])
    )
  })
  return await new Promise((resolve, reject) => {
    const keyPair = generateKeyPair()
    const serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    const sharedKey = deriveSharedKey(keyPair.secretKey, serverPublicKey)
    let state: HandshakeState = 'awaiting_ready'
    let settled = false
    let closing = false
    let terminalFailure = false
    let ws: WebSocket | null = null
    let liveness: RemoteRuntimeSocketLivenessMonitor | null = null
    let outboundSocketMemoryCloseSource: WebSocket | null = null
    const pendingRequests = new Map<string, PendingRemoteRuntimeSubscriptionRequest>()

    const releaseOutboundQueueMemory = (): void => {
      sendQueue?.dispose()
      sendQueue = null
      requestQueue?.dispose()
      requestQueue = null
    }

    const releaseOutboundSocketMemory = (): void => {
      outboundSocketMemory?.release()
      outboundSocketMemory = null
      outboundSocketMemoryCloseSource = null
    }

    const retainOutboundSocketMemoryUntilClose = (socket: WebSocket): void => {
      if (socket.readyState === WebSocket.CLOSED) {
        releaseOutboundSocketMemory()
        return
      }
      if (outboundSocketMemoryCloseSource === socket) {
        return
      }
      outboundSocketMemoryCloseSource = socket
      socket.once('close', releaseOutboundSocketMemory)
    }

    const cleanupSocketListeners = (): WebSocket | null => {
      liveness?.stop()
      liveness = null
      releaseOutboundQueueMemory()
      const socket = ws
      if (!socket) {
        if (!outboundSocketMemoryCloseSource) {
          releaseOutboundSocketMemory()
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
      retainOutboundSocketMemoryUntilClose(socket)
      // Why: startup failures detach Orca callbacks before closing the ws,
      // but ws can still emit a late transport error while close is in flight.
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
      rejectPendingRequests(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'Remote runtime subscription closed before its request completed.'
        )
      )
      releaseOutboundQueueMemory()
      if (ws) {
        retainOutboundSocketMemoryUntilClose(ws)
      } else if (!outboundSocketMemoryCloseSource) {
        releaseOutboundSocketMemory()
      }
      try {
        ws?.close()
      } catch {
        // ignore best-effort close
      }
    }

    // Why: client input (keystrokes) must never be dropped under backpressure.
    // Hold encrypted frames in order while bufferedAmount is over the cap and
    // drain as it clears; a wedged link (hard cap) fails the socket so the
    // renderer resubscribes and replays a fresh snapshot.
    let sendQueue: ReturnType<typeof createWsOutboundBackpressureQueue<Buffer>> | null = null
    let requestQueue: ReturnType<typeof createWsOutboundBackpressureQueue<string>> | null = null
    let outboundSocketMemory: RemoteRuntimeOutboundSocketMemory | null = null
    const ensureOutboundSocketMemory = (socket: WebSocket): boolean => {
      const memoryBudget = options?.outboundMemoryBudget
      if (!memoryBudget || outboundSocketMemory) {
        return true
      }
      outboundSocketMemory = memoryBudget.registerBufferedAmount(() => socket.bufferedAmount)
      if (outboundSocketMemory) {
        return true
      }
      fail(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'Remote Orca runtime outbound memory admission failed; reconnecting.'
        )
      )
      return false
    }
    const ensureSendQueue = (
      socket: WebSocket
    ): ReturnType<typeof createWsOutboundBackpressureQueue<Buffer>> | null => {
      if (!sendQueue) {
        const memoryBudget = options?.outboundMemoryBudget
        if (!ensureOutboundSocketMemory(socket)) {
          return null
        }
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
            ),
          ...options?.outboundQueue,
          canSend: (bytes, alreadyRetained) =>
            outboundSocketMemory?.canSend(bytes, alreadyRetained) ?? true,
          ...(memoryBudget
            ? {
                claimQueuedBytes: (bytes: number) => memoryBudget.claimQueuedBytes(bytes)
              }
            : {})
        })
      }
      return sendQueue
    }

    const ensureRequestQueue = (
      socket: WebSocket
    ): ReturnType<typeof createWsOutboundBackpressureQueue<string>> | null => {
      if (!requestQueue) {
        const memoryBudget = options?.outboundMemoryBudget
        if (!ensureOutboundSocketMemory(socket)) {
          return null
        }
        requestQueue = createWsOutboundBackpressureQueue<string>({
          send: (frame) => socket.send(frame),
          byteLengthOf: (frame) => Buffer.byteLength(frame),
          getBufferedAmount: () => socket.bufferedAmount,
          isWritable: () => socket.readyState === WebSocket.OPEN,
          onOverflow: () =>
            fail(
              new RemoteRuntimeClientError(
                'remote_runtime_unavailable',
                'Remote runtime subscription request buffer overflow; reconnecting.'
              )
            ),
          softCapBytes: SUBSCRIPTION_REQUEST_SOFT_CAP_BYTES,
          maxQueuedBytes: SUBSCRIPTION_REQUEST_MAX_QUEUED_BYTES,
          maxQueuedFrames: SUBSCRIPTION_REQUEST_MAX_QUEUED_FRAMES,
          canSend: (bytes, alreadyRetained) =>
            outboundSocketMemory?.canSend(bytes, alreadyRetained) ?? true,
          ...(memoryBudget
            ? {
                claimQueuedBytes: (bytes: number) => memoryBudget.claimQueuedBytes(bytes)
              }
            : {})
        })
      }
      return requestQueue
    }

    const sendBinary = (bytes: Uint8Array<ArrayBufferLike>): boolean => {
      if (
        !isRemoteRuntimeBinaryFrameWithinLimit(bytes) ||
        state !== 'ready' ||
        !ws ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return false
      }
      return ensureSendQueue(ws)?.enqueue(Buffer.from(encryptBytes(bytes, sharedKey))) ?? false
    }

    const succeed = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ requestId, close, sendBinary, sendRequest })
    }

    const fail = (error: RemoteRuntimeClientError): void => {
      if (terminalFailure || closing) {
        return
      }
      terminalFailure = true
      rejectPendingRequests(error)
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        closeSocketAfterCleanup()
        reject(error)
        return
      }
      callbacks.onError(error)
      // Why: after a subscription is established, protocol failures are
      // terminal for this socket. Closing here releases the WebSocket listeners
      // and lets the IPC subscription registry drop its retained callbacks.
      closeSocketAfterCleanup()
      callbacks.onClose?.()
    }

    function rejectPendingRequests(error: RemoteRuntimeClientError): void {
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timeout)
        pending.reject(error)
      }
      pendingRequests.clear()
    }

    function sendRequest(
      requestMethod: string,
      requestParams: unknown,
      requestTimeoutMs: number
    ): Promise<RuntimeRpcResponse<unknown>> {
      if (!isSafeTimerDelayMs(requestTimeoutMs)) {
        return Promise.reject(
          new RemoteRuntimeClientError(
            'invalid_argument',
            `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
          )
        )
      }
      const socket = ws
      if (state !== 'ready' || !socket || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote runtime subscription is not writable.'
          )
        )
      }
      if (pendingRequests.size >= MAX_PENDING_SUBSCRIPTION_REQUESTS) {
        return Promise.reject(
          new RemoteRuntimeClientError(
            'runtime_busy',
            'Remote runtime subscription request capacity reached.'
          )
        )
      }
      const nestedRequestId = randomUUID()
      let serialized: string
      try {
        serialized = serializeRemoteRuntimeRpcRequest({
          requestId: nestedRequestId,
          deviceToken: pairing.deviceToken,
          method: requestMethod,
          params: requestParams
        })
      } catch (error) {
        return Promise.reject(
          error instanceof RemoteRuntimeClientError
            ? error
            : new RemoteRuntimeClientError('invalid_argument', String(error))
        )
      }
      const encrypted = encrypt(serialized, sharedKey)
      return new Promise((resolveRequest, rejectRequest) => {
        const timeout = setTimeout(() => {
          fail(
            new RemoteRuntimeClientError(
              'runtime_timeout',
              'Timed out waiting for a remote runtime subscription request.'
            )
          )
        }, requestTimeoutMs)
        pendingRequests.set(nestedRequestId, {
          resolve: resolveRequest,
          reject: rejectRequest,
          timeout
        })
        if (!ensureRequestQueue(socket)?.enqueue(encrypted)) {
          fail(
            new RemoteRuntimeClientError(
              'remote_runtime_unavailable',
              'Remote runtime subscription request could not be queued.'
            )
          )
        }
      })
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
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: publicKeyToBase64(keyPair.publicKey)
        })
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
      rejectPendingRequests(
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
      if (isBinary) {
        handleBinaryFrame(new Uint8Array(data as Buffer))
        return
      }

      const frame = data.toString()
      if (state === 'awaiting_ready') {
        handleReadyFrame(frame)
        return
      }

      const plaintext = decrypt(frame, sharedKey)
      if (plaintext === null) {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an undecryptable frame.'
          )
        )
        return
      }

      if (state === 'awaiting_authenticated') {
        handleAuthenticatedFrame(plaintext)
        return
      }

      handleRpcFrame(plaintext)
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

    // Why: dedicated stream sockets (terminal.multiplex, browser.screencast)
    // ride the same tunnels as shared control; a half-open drop must surface
    // as a close so the renderer's onTransportClose resubscribe path runs
    // instead of freezing the stream forever (#7718/#7489).
    const monitoredWs = ws
    liveness = startRemoteRuntimeSocketLiveness({
      ping: () => {
        if (monitoredWs.readyState === WebSocket.OPEN) {
          monitoredWs.ping()
        }
      },
      onDead: () => {
        // Why: fail() first so listeners detach before terminate's close event;
        // otherwise the close handler would emit a second onClose to callers.
        fail(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote Orca runtime stopped responding; the stream connection was reset.'
          )
        )
        try {
          // Why: close() on a half-open socket can hang for the OS TCP timeout.
          monitoredWs.terminate()
        } catch {
          // Best-effort terminate; the subscription is already settled.
        }
      },
      options
    })

    function handleReadyFrame(frame: string): void {
      let ready: unknown
      try {
        ready = parseRemoteRuntimeJsonText(frame)
      } catch {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid E2EE handshake frame.'
          )
        )
        return
      }
      if (
        typeof ready !== 'object' ||
        ready === null ||
        (ready as { type?: unknown }).type !== 'e2ee_ready'
      ) {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an unexpected E2EE handshake frame.'
          )
        )
        return
      }
      state = 'awaiting_authenticated'
      ws?.send(encrypt(serializedAuth, sharedKey))
    }

    function handleAuthenticatedFrame(plaintext: string): void {
      let authenticated: unknown
      try {
        authenticated = parseRemoteRuntimeJsonText(plaintext)
      } catch {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid E2EE auth frame.'
          )
        )
        return
      }
      const type = (authenticated as { type?: unknown }).type
      if (type !== 'e2ee_authenticated') {
        const code =
          typeof authenticated === 'object' &&
          authenticated !== null &&
          (authenticated as { error?: { code?: unknown } }).error?.code === 'unauthorized'
            ? 'unauthorized'
            : 'invalid_runtime_response'
        fail(new RemoteRuntimeClientError(code, 'Remote Orca runtime rejected the pairing token.'))
        return
      }
      state = 'ready'
      ws?.send(encrypt(serializedRequest, sharedKey))
      succeed()
    }

    function handleRpcFrame(plaintext: string): void {
      let raw: unknown
      try {
        raw = parseRemoteRuntimeJsonText(plaintext)
      } catch {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid response frame.'
          )
        )
        return
      }
      const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
      if (!parsed.success || '_keepalive' in parsed.data) {
        return
      }
      const response = parsed.data as RuntimeRpcResponse<TResult>
      if (response.id === requestId) {
        callbacks.onResponse(response)
        return
      }
      const pending = pendingRequests.get(response.id)
      if (!pending) {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned a mismatched response id.'
          )
        )
        return
      }
      pendingRequests.delete(response.id)
      clearTimeout(pending.timeout)
      pending.resolve(response)
    }

    function handleBinaryFrame(frame: Uint8Array<ArrayBufferLike>): void {
      if (state !== 'ready') {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned binary data before authentication.'
          )
        )
        return
      }
      const plaintext = decryptBytes(frame, sharedKey)
      if (plaintext === null) {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an undecryptable binary frame.'
          )
        )
        return
      }
      callbacks.onBinary?.(plaintext)
    }
  })
}
