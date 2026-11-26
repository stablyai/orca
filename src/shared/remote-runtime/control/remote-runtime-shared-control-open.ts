import { prepareOpenRefusal } from './remote-runtime-shared-control-hold'
import type {
  RemoteRuntimeSharedControlConnectionOptions,
  SharedControlSocketCloseCause
} from './remote-runtime-shared-control-types'
import type WebSocket from 'ws'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import {
  ORCAD_IDLE_STOP_CLOSE_CODE,
  RUNTIME_IDLE_STOPPED_ERROR_CODE,
  RUNTIME_IDLE_STOPPED_MESSAGE
} from '../orcad-lifecycle/orcad-idle-stop-signal'
import {
  openRemoteRuntimeWebSocket,
  type RemoteRuntimeWebSocket
} from '../requests/remote-runtime-request-websocket'
import { formatSharedControlCloseMessage } from './remote-runtime-shared-control-protocol'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessOptions
} from '../remote-runtime-socket-liveness'
import type { RemoteRuntimeSealedFrame } from '../remote-runtime-sealed-frame'

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
    /** The current socket finished its opening handshake. */
    onOpened: () => void
    onFrame: (frame: RemoteRuntimeSealedFrame) => void
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
    onOpen: (ws) => {
      if (callbacks.getCurrentSocket() === ws) {
        callbacks.onOpened()
      }
    },
    onClose: (ws, code, reason) => {
      if (callbacks.getCurrentSocket() === ws) {
        callbacks.onSocketClosed(
          // Pending requests fail with this code, which tells callers they were never dispatched.
          code === ORCAD_IDLE_STOP_CLOSE_CODE
            ? new RemoteRuntimeClientError(
                RUNTIME_IDLE_STOPPED_ERROR_CODE,
                RUNTIME_IDLE_STOPPED_MESSAGE
              )
            : remoteRuntimeUnavailableError(formatSharedControlCloseMessage(code, reason)),
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
    onFrame: (ws, frame) => {
      if (callbacks.getCurrentSocket() === ws) {
        noteActivity()
        callbacks.onFrame(frame)
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

/** Preparation and socket installation share the generation that admitted the open. */
export async function openPreparedSharedControlSocket(
  connection: PairedRuntimeConnection,
  options: RemoteRuntimeSharedControlConnectionOptions,
  args: {
    current: () => boolean
    prepared: () => void
    hasDemand: () => boolean
    refuse: (error: RemoteRuntimeClientError) => void
    callbacks: Parameters<typeof openSharedControlSocket>[1]
    accept: (opened: ReturnType<typeof openSharedControlSocket>) => void
  }
): Promise<void> {
  const refusal = await prepareOpenRefusal(false, options)
  if (!args.current()) {
    return
  }
  args.prepared()
  if (!args.hasDemand()) {
    return
  }
  const error = refusal()
  if (error) {
    args.refuse(error)
    return
  }
  const { onSocketClosed } = args.callbacks
  args.accept(
    openSharedControlSocket(connection, {
      ...args.callbacks,
      onSocketClosed: (error, cause, close) => {
        // Before the close is handled, so the retry it schedules already sees the hold.
        if (close?.code === ORCAD_IDLE_STOP_CLOSE_CODE) {
          options.onIdleStop?.()
        }
        onSocketClosed(error, cause, close)
      }
    })
  )
}
