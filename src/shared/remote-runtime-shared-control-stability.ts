import WebSocket from 'ws'
import type { SharedControlConnectionState } from './remote-runtime-shared-control-types'

export function scheduleSharedControlStableReset(args: {
  delayMs: number
  getState: () => SharedControlConnectionState
  getSocket: () => WebSocket | null
  reset: () => void
  clearCurrent: () => void
}): ReturnType<typeof setTimeout> {
  // Why: reset only after a stable ready period. Immediate reset would make
  // authenticate-then-close loops retry forever instead of exhausting.
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

// Why: owns the ready-stable timer's lifecycle so the connection only wires
// state accessors; scheduling always replaces any earlier pending timer.
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
