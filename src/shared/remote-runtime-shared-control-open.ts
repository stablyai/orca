import type WebSocket from 'ws'
import type { PairedRuntimeConnection } from './paired-runtime-connection'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import {
  openRemoteRuntimeWebSocket,
  type RemoteRuntimeWebSocket
} from './remote-runtime-request-websocket'
import { formatSharedControlCloseMessage } from './remote-runtime-shared-control-protocol'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessOptions
} from './remote-runtime-socket-liveness'

export function openSharedControlSocket(
  connection: PairedRuntimeConnection,
  callbacks: {
    getCurrentSocket: () => WebSocket | null
    onClose: (close: { code: number; reason: string }, error: RemoteRuntimeClientError) => void
    onError: (error: RemoteRuntimeClientError) => void
    onTextFrame: (frame: string) => void
    /** Any inbound frame, ping or pong on the current socket. */
    onActivity?: () => void
    // Why: reconnect is edge-triggered on `close`, but a half-open tunnel
    // never delivers one. Liveness pings and declares the socket dead when
    // the server goes silent, so the close/reconnect path can run (#7718).
    liveness?: {
      options?: RemoteRuntimeSocketLivenessOptions
      onDead: (error: RemoteRuntimeClientError) => void
    }
  }
): { ok: true; socket: RemoteRuntimeWebSocket } | { ok: false; error: RemoteRuntimeClientError } {
  let noteLiveness: () => void = () => {}
  const noteActivity = (): void => {
    noteLiveness()
    callbacks.onActivity?.()
  }
  const opened = openRemoteRuntimeWebSocket(connection, {
    onClose: (ws, code, reason) => {
      if (callbacks.getCurrentSocket() === ws) {
        callbacks.onClose(
          { code, reason: reason.toString() },
          remoteRuntimeUnavailableError(formatSharedControlCloseMessage(code, reason))
        )
      }
    },
    onError: (ws, error) => {
      if (callbacks.getCurrentSocket() === ws) {
        callbacks.onError(error)
      }
    },
    onTextFrame: (ws, frame) => {
      if (callbacks.getCurrentSocket() === ws) {
        noteActivity()
        callbacks.onTextFrame(frame)
      }
    },
    onPong: (ws) => {
      if (callbacks.getCurrentSocket() === ws) {
        noteActivity()
      }
    },
    onPing: (ws) => {
      if (callbacks.getCurrentSocket() === ws) {
        noteActivity()
      }
    }
  })
  if (!opened.ok || !callbacks.liveness) {
    return opened
  }

  const { ws, handshake, cleanup } = opened.socket
  const liveness = callbacks.liveness
  const monitor = startRemoteRuntimeSocketLiveness({
    ping: () => {
      if (ws.readyState !== 1) {
        return false
      }
      ws.ping()
      return true
    },
    onDead: () => {
      if (callbacks.getCurrentSocket() !== ws) {
        return
      }
      try {
        // Why: close() on a half-open socket can hang for the OS TCP timeout.
        ws.terminate()
      } catch {
        // Best-effort terminate; the dead callback resets connection state.
      }
      liveness.onDead(
        remoteRuntimeUnavailableError(
          'Remote Orca runtime stopped responding; resetting the control connection.'
        )
      )
    },
    options: liveness.options
  })
  noteLiveness = monitor.noteActivity

  return {
    ok: true,
    socket: {
      ws,
      handshake,
      cleanup: () => {
        monitor.stop()
        cleanup()
      }
    }
  }
}
