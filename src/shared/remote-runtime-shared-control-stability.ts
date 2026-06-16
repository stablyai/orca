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
