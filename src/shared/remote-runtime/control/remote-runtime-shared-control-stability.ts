import WebSocket from 'ws'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
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

/** The current socket's one readiness timer: its OPEN→ready deadline, then its stable-ready backoff reset. */
export class SharedControlReadinessTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: Pick<
      RemoteRuntimeSharedControlConnectionOptions,
      'reconnectStableResetMs' | 'readyDeadlineMs'
    >,
    private readonly args: {
      getState: () => SharedControlConnectionState
      getSocket: () => WebSocket | null
      resetAttempt: () => void
      retire: SharedControlSocketClosed
    }
  ) {}

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

  scheduleStableReset(): void {
    this.clear()
    this.timer = scheduleSharedControlStableReset({
      delayMs: this.options.reconnectStableResetMs ?? 30_000,
      getState: this.args.getState,
      getSocket: this.args.getSocket,
      reset: this.args.resetAttempt,
      clearCurrent: () => {
        this.timer = null
      }
    })
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
