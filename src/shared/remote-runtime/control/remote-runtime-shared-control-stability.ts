import WebSocket from 'ws'
import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import { SharedControlAppHeartbeat } from './remote-runtime-shared-control-app-heartbeat'
import type {
  RemoteRuntimeSharedControlConnectionOptions,
  SharedControlConnectionState,
  SharedControlSocketClosed
} from './remote-runtime-shared-control-types'

/** Bounds OPEN→ready: pongs prove transport only, so a socket that never readies must still be retired (#37330).
 * Well above the host's 10s pre-auth reaper and one 15s caller wait, so a slow older host is not cut off. */
const SHARED_CONTROL_READY_DEADLINE_MS = 30_000

export function scheduleSharedControlStableReset(args: {
  delayMs: number
  getState: () => SharedControlConnectionState
  getSocket: () => WebSocket | null
  reset: () => void
  clearCurrent: () => void
}): ReturnType<typeof setTimeout> {
  // Reset only after stable readiness so authenticate/close loops retain their accumulated backoff.
  const timer = setTimeout(() => {
    if (args.getState() === 'ready' && args.getSocket()?.readyState === WebSocket.OPEN) {
      args.reset()
    }
    args.clearCurrent()
  }, args.delayMs)
  if (typeof timer.unref === 'function') {
    timer.unref()
  }
  return timer
}

/** The current socket's readiness: its OPEN→ready deadline, its stable-ready backoff reset, and its
 * opt-in app-level heartbeat once ready. */
export class SharedControlReadinessTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly heartbeat: SharedControlAppHeartbeat | null

  constructor(
    private readonly options: Pick<
      RemoteRuntimeSharedControlConnectionOptions,
      | 'reconnectStableResetMs'
      | 'readyDeadlineMs'
      | 'appHeartbeat'
      | 'isManuallyDisconnected'
      | 'isAsleep'
    >,
    private readonly args: {
      getState: () => SharedControlConnectionState
      getSocket: () => WebSocket | null
      resetAttempt: () => void
      retire: SharedControlSocketClosed
      probe?: (timeoutMs: number) => Promise<RuntimeRpcResponse<unknown>>
      onHealthChanged?: () => void
    }
  ) {
    const { probe } = args
    this.heartbeat =
      options.appHeartbeat && probe
        ? new SharedControlAppHeartbeat(options.appHeartbeat, {
            probe,
            // clear() stops the heartbeat whenever the socket changes, so only readiness needs checking.
            isCurrent: () => args.getState() === 'ready',
            shouldProbe: () =>
              !(options.isManuallyDisconnected?.() ?? false) && !(options.isAsleep?.() ?? false),
            onUnresponsive: (generation) =>
              args.retire(
                remoteRuntimeUnavailableError(
                  'Remote Orca runtime stopped answering requests; resetting the control connection.'
                ),
                generation,
                'runtime_unresponsive'
              ),
            onRecovered: () => {
              args.resetAttempt()
              args.onHealthChanged?.()
            }
          })
        : null
  }

  /** When the runtime first missed a heartbeat; survives reconnects until it answers again. */
  get unresponsiveSince(): number | null {
    return this.heartbeat?.unresponsiveAt ?? null
  }

  /** Any sealed frame on the current socket came from the runtime itself. */
  noteAnswer(): void {
    this.heartbeat?.noteAnswer()
  }

  armReadyDeadline(generation: number): void {
    this.clear()
    const timer = setTimeout(() => {
      this.timer = null
      this.args.retire(
        remoteRuntimeUnavailableError(
          'Remote Orca runtime did not finish connecting; resetting the control connection.'
        ),
        generation,
        'ready_timeout'
      )
    }, this.options.readyDeadlineMs ?? SHARED_CONTROL_READY_DEADLINE_MS)
    timer.unref?.()
    this.timer = timer
  }

  scheduleStableReset(generation?: number): void {
    this.clear()
    if (generation !== undefined) {
      this.heartbeat?.start(generation)
    }
    this.timer = scheduleSharedControlStableReset({
      delayMs: this.options.reconnectStableResetMs ?? 30_000,
      getState: this.args.getState,
      getSocket: this.args.getSocket,
      // Why: a runtime that readies but never answers must keep its accumulated reconnect backoff.
      reset: () => {
        if (this.unresponsiveSince === null) {
          this.args.resetAttempt()
        }
      },
      clearCurrent: () => {
        this.timer = null
      }
    })
  }

  clear(): void {
    this.heartbeat?.stop()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
