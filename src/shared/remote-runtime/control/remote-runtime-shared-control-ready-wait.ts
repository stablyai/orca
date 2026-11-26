import type { AuthenticatedRuntimeChannel } from './remote-runtime-authenticated-channel'
import type {
  SharedControlConnectionState,
  SharedControlReadyWaiter
} from './remote-runtime-shared-control-types'
import {
  isSharedControlReady,
  waitForSharedControlReadyWithTimeout
} from './remote-runtime-shared-control-ready'

export function ensureSharedControlReady(args: {
  state: SharedControlConnectionState
  channel: AuthenticatedRuntimeChannel | null
  readyWaiters: SharedControlReadyWaiter[]
  timeoutMs: number
  signal?: AbortSignal
  open: () => void
}): Promise<void> {
  if (isSharedControlReady(args)) {
    return Promise.resolve()
  }
  return waitForSharedControlReadyWithTimeout({
    readyWaiters: args.readyWaiters,
    timeoutMs: args.timeoutMs,
    signal: args.signal,
    open: args.open
  })
}
