import WebSocket from 'ws'
import type { PairedRuntimeConnection } from '../../paired-runtime-connection'
import type { PairedE2EEClientHandshake } from '../../paired-e2ee-client-handshake'
import { createRemoteRuntimeSocketProtocol } from '../remote-runtime-relay-protocol'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import {
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from '../remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../remote-runtime-memory-limits'
import {
  invalidRemoteRuntimeResponseError,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'

export type RemoteRuntimeWebSocket = {
  ws: WebSocket
  handshake: PairedE2EEClientHandshake
  cleanup: () => void
}

export type RemoteRuntimeWebSocketCallbacks = {
  onClose: (ws: WebSocket, code: number, reason: Buffer) => void
  onError: (ws: WebSocket, error: RemoteRuntimeClientError) => void
  onTextFrame: (ws: WebSocket, frame: string) => void
  // Why optional: request sockets treat a binary frame as a protocol error; a relay forwards it.
  onBinaryFrame?: (ws: WebSocket, frame: Uint8Array<ArrayBufferLike>) => void
  // Pongs and heartbeat pings expose half-open tunnels that never emit close (#7718).
  onPong?: (ws: WebSocket) => void
  onPing?: (ws: WebSocket) => void
}

export function openRemoteRuntimeWebSocket(
  connection: PairedRuntimeConnection,
  callbacks: RemoteRuntimeWebSocketCallbacks,
  // Override for connect-bound tests without waiting the production timeout.
  connectTimeoutMs?: number
): { ok: true; socket: RemoteRuntimeWebSocket } | { ok: false; error: RemoteRuntimeClientError } {
  const opened = createSocket(connection, connectTimeoutMs)
  if (!opened.ok) {
    return opened
  }
  const { ws, handshake, protocol } = opened

  let cleanedUp = false
  const onOpen = (): void => {
    try {
      protocol.open((frame) => ws.send(frame))
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
  const onError = (error: Error): void => {
    callbacks.onError(
      ws,
      error instanceof RemoteRuntimeClientError
        ? error
        : remoteRuntimeUnavailableError(
            remoteRuntimeConnectFailureMessage(error, protocol.endpoint)
          )
    )
  }
  const onClose = (code: number, reason: Buffer): void => callbacks.onClose(ws, code, reason)
  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    if (isBinary && callbacks.onBinaryFrame && Buffer.isBuffer(data)) {
      callbacks.onBinaryFrame(ws, new Uint8Array(data))
      return
    }
    if (isBinary) {
      callbacks.onError(
        ws,
        invalidRemoteRuntimeResponseError(
          'Remote Orca runtime returned an unexpected binary frame.'
        )
      )
      return
    }
    try {
      if (!protocol.accept(data.toString(), (frame) => ws.send(frame))) {
        callbacks.onTextFrame(ws, data.toString())
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
  const onPong = (): void => callbacks.onPong?.(ws)
  const onPing = (): void => callbacks.onPing?.(ws)
  const cleanup = (): void => {
    if (cleanedUp) {
      return
    }
    cleanedUp = true
    ws.off('open', onOpen)
    ws.off('error', onError)
    ws.off('close', onClose)
    ws.off('message', onMessage)
    ws.off('pong', onPong)
    ws.off('ping', onPing)
    // Retain an error listener for late transport errors after manual close.
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.on('error', ignoreLateSocketError)
    }
  }

  ws.once('open', onOpen)
  ws.on('error', onError)
  ws.on('close', onClose)
  ws.on('message', onMessage)
  ws.on('pong', onPong)
  ws.on('ping', onPing)
  return { ok: true, socket: { ws, handshake, cleanup } }
}

function ignoreLateSocketError(): void {}

function createSocket(
  connection: PairedRuntimeConnection,
  connectTimeoutMs?: number
):
  | {
      ok: true
      ws: WebSocket
      handshake: PairedE2EEClientHandshake
      protocol: ReturnType<typeof createRemoteRuntimeSocketProtocol>
    }
  | { ok: false; error: RemoteRuntimeClientError } {
  let protocol: ReturnType<typeof createRemoteRuntimeSocketProtocol>
  try {
    protocol = createRemoteRuntimeSocketProtocol(connection)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: new RemoteRuntimeClientError(
        'invalid_argument',
        `Invalid remote pairing key: ${message}`
      )
    }
  }
  try {
    return {
      ok: true,
      // Why: no runtime frame exceeds this, so a larger one is a broken peer, not a payload to buffer.
      ws: new WebSocket(
        protocol.endpoint,
        remoteRuntimeConnectOptions(
          { maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES },
          connectTimeoutMs
        )
      ),
      handshake: protocol.handshake,
      protocol
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: new RemoteRuntimeClientError('invalid_argument', `Invalid remote endpoint: ${message}`)
    }
  }
}
