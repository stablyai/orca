/* oxlint-disable max-lines -- Why: one-shot and streaming remote clients share the
 * same E2EE handshake and response validation state; keep them together until
 * the terminal transport is fully migrated and a stable shared connection
 * abstraction emerges. */
import { randomUUID } from 'crypto'
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
  type RuntimeRpcResponse
} from './runtime-rpc-envelope'

type HandshakeState = 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

export class RemoteRuntimeClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteRuntimeClientError'
    this.code = code
  }
}

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
}

export type RemoteRuntimeSubscriptionCallbacks<TResult = unknown> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

export async function sendRemoteRuntimeRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<RuntimeRpcResponse<TResult>> {
  return await new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const keyPair = generateKeyPair()
    const serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    const sharedKey = deriveSharedKey(keyPair.secretKey, serverPublicKey)
    let state: HandshakeState = 'awaiting_ready'
    let settled = false
    let ws: WebSocket | null = null

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

    const timeout = setTimeout(() => {
      finish({
        ok: false,
        error: new RemoteRuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the remote Orca runtime to respond.'
        )
      })
    }, timeoutMs)

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
      ws = new WebSocket(pairing.endpoint)
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
          'Could not connect to the remote Orca runtime.'
        )
      })
    }

    function onClose(code: number, reason: Buffer): void {
      if (!settled) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            formatRemoteRuntimeCloseMessage(code, reason)
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
            'Remote Orca runtime returned an unexpected binary frame.'
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
            'Remote Orca runtime returned an undecryptable frame.'
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
        ready = JSON.parse(frame)
      } catch {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid E2EE handshake frame.'
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
            'Remote Orca runtime returned an unexpected E2EE handshake frame.'
          )
        })
        return
      }
      state = 'awaiting_authenticated'
      ws?.send(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }), sharedKey)
      )
    }

    function handleAuthenticatedFrame(plaintext: string): void {
      let authenticated: unknown
      try {
        authenticated = JSON.parse(plaintext)
      } catch {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid E2EE auth frame.'
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
            'Remote Orca runtime rejected the pairing token.'
          )
        })
        return
      }
      state = 'ready'
      ws?.send(
        encrypt(
          JSON.stringify({
            id: requestId,
            deviceToken: pairing.deviceToken,
            method,
            params
          }),
          sharedKey
        )
      )
    }

    function handleRpcFrame(plaintext: string): void {
      let raw: unknown
      try {
        raw = JSON.parse(plaintext)
      } catch {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid response frame.'
          )
        })
        return
      }
      if (isKeepaliveFrame(raw)) {
        timeout.refresh()
        return
      }
      const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
      if (!parsed.success || '_keepalive' in parsed.data) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned an invalid response frame.'
          )
        })
        return
      }
      const response = parsed.data as RuntimeRpcResponse<TResult>
      if (response.id !== requestId) {
        finish({
          ok: false,
          error: new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned a mismatched response id.'
          )
        })
        return
      }
      finish({ ok: true, response })
    }
  })
}

export async function subscribeRemoteRuntimeRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: RemoteRuntimeSubscriptionCallbacks<TResult>
): Promise<RemoteRuntimeSubscription> {
  return await new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const keyPair = generateKeyPair()
    const serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    const sharedKey = deriveSharedKey(keyPair.secretKey, serverPublicKey)
    let state: HandshakeState = 'awaiting_ready'
    let settled = false
    let ws: WebSocket | null = null

    const cleanupSocketListeners = (): WebSocket | null => {
      const socket = ws
      if (!socket) {
        return null
      }
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('message', onMessage)
      ws = null
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
      try {
        ws?.close()
      } catch {
        // ignore best-effort close
      }
    }

    const sendBinary = (bytes: Uint8Array<ArrayBufferLike>): boolean => {
      if (state !== 'ready' || !ws || ws.readyState !== WebSocket.OPEN) {
        return false
      }
      ws.send(Buffer.from(encryptBytes(bytes, sharedKey)), { binary: true })
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
      // Why: after a subscription is established, protocol failures are
      // terminal for this socket. Closing here releases the WebSocket listeners
      // and lets the IPC subscription registry drop its retained callbacks.
      closeSocketAfterCleanup()
      callbacks.onClose?.()
    }

    try {
      ws = new WebSocket(pairing.endpoint)
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

    ws.once('open', onOpen)
    ws.once('error', onError)
    ws.on('close', onClose)
    ws.on('message', onMessage)

    function handleReadyFrame(frame: string): void {
      let ready: unknown
      try {
        ready = JSON.parse(frame)
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
      ws?.send(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }), sharedKey)
      )
    }

    function handleAuthenticatedFrame(plaintext: string): void {
      let authenticated: unknown
      try {
        authenticated = JSON.parse(plaintext)
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
      ws?.send(
        encrypt(
          JSON.stringify({
            id: requestId,
            deviceToken: pairing.deviceToken,
            method,
            params
          }),
          sharedKey
        )
      )
      succeed()
    }

    function handleRpcFrame(plaintext: string): void {
      let raw: unknown
      try {
        raw = JSON.parse(plaintext)
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
      if (response.id !== requestId) {
        fail(
          new RemoteRuntimeClientError(
            'invalid_runtime_response',
            'Remote Orca runtime returned a mismatched response id.'
          )
        )
        return
      }
      callbacks.onResponse(response)
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
