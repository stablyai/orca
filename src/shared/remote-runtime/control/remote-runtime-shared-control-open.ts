import type WebSocket from 'ws'
import type { PairedRuntimeConnection } from '../../paired-runtime-connection'
import type { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import {
  openRemoteRuntimeWebSocket,
  type RemoteRuntimeWebSocket
} from '../requests/remote-runtime-request-websocket'
import { formatSharedControlCloseMessage } from './remote-runtime-shared-control-protocol'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessOptions
} from '../remote-runtime-socket-liveness'
import type { SharedControlSocketCloseCause } from './remote-runtime-shared-control-types'

export function openSharedControlSocket(
  connection: PairedRuntimeConnection,
  callbacks: {
    getCurrentSocket: () => WebSocket | null
    /** The current socket closed, errored or went silent; `close` is set for a close frame only. */
    onSocketClosed: (
      error: RemoteRuntimeClientError,
      cause: SharedControlSocketCloseCause,
      close?: { code: number; reason: string }
    ) => void
    onTextFrame: (frame: string) => void
    /** Any inbound frame, ping or pong on the current socket. */
    onActivity?: () => void
    // Half-open tunnels never emit close; liveness must trigger the close/reconnect path (#7718).
    liveness?: {
      options?: RemoteRuntimeSocketLivenessOptions
      onRoundTrip?: (rttMs: number) => void
    }
  }
): { ok: true; socket: RemoteRuntimeWebSocket } | { ok: false; error: RemoteRuntimeClientError } {
  let noteLiveness: () => void = () => {}
  let notePong: () => void = () => {}
  const noteActivity = (): void => {
    noteLiveness()
    callbacks.onActivity?.()
  }
  const opened = openRemoteRuntimeWebSocket(connection, {
    onClose: (ws, code, reason) => {
      if (callbacks.getCurrentSocket() === ws) {
        callbacks.onSocketClosed(
          remoteRuntimeUnavailableError(formatSharedControlCloseMessage(code, reason)),
          'socket_close',
          { code, reason: reason.toString() }
        )
      }
    },
    onError: (ws, error) => {
      if (callbacks.getCurrentSocket() === ws) {
        const cause = error.code === 'invalid_runtime_response' ? 'protocol_error' : 'socket_error'
        callbacks.onSocketClosed(error, cause)
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
        notePong()
        callbacks.onActivity?.()
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
    onDead: (cause) => {
      if (callbacks.getCurrentSocket() !== ws) {
        return
      }
      try {
        // Why: close() on a half-open socket can hang for the OS TCP timeout.
        ws.terminate()
      } catch {
        // Best-effort terminate; the dead callback resets connection state.
      }
      callbacks.onSocketClosed(
        remoteRuntimeUnavailableError(
          'Remote Orca runtime stopped responding; resetting the control connection.'
        ),
        cause
      )
    },
    onRoundTrip: liveness.onRoundTrip,
    options: liveness.options
  })
  noteLiveness = monitor.noteActivity
  notePong = monitor.notePong

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
