import WebSocket from 'ws'
import type { SharedControlConnectionState } from './remote-runtime-shared-control-types'

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

// Replace any prior stable-ready timer when scheduling.
export class SharedControlReadyStableResetTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly delayMs: number) {}

  schedule(args: {
    getState: () => SharedControlConnectionState
    getSocket: () => WebSocket | null
    reset: () => void
  }): void {
    this.clear()
    this.timer = scheduleSharedControlStableReset({
      delayMs: this.delayMs,
      getState: args.getState,
      getSocket: args.getSocket,
      reset: args.reset,
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
