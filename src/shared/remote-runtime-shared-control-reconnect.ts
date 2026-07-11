import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { isRecoverableRemoteRuntimeConnectionError } from './remote-runtime-client-error-classification'
import {
  finishSharedControlSubscriptions,
  scheduleSharedControlReconnect
} from './remote-runtime-shared-control-state'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

const REMOTE_RUNTIME_SHARED_CONTROL_RECONNECT_DELAYS_MS = [
  250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000
] as const

export function scheduleSharedControlReconnectWhileSubscribed(args: {
  current: ReturnType<typeof setTimeout> | null
  isIntentionallyClosed: () => boolean
  reconnectAttempt: number
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  getCurrentTimer: () => ReturnType<typeof setTimeout> | null
  onTimerFired: () => void
  open: () => void
}): { timer: ReturnType<typeof setTimeout> | null; reconnectAttempt: number } {
  if (args.subscriptions.size === 0) {
    return { timer: null, reconnectAttempt: args.reconnectAttempt }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const scheduled = scheduleSharedControlReconnect({
    current: args.current,
    intentionallyClosed: args.isIntentionallyClosed(),
    reconnectAttempt: args.reconnectAttempt,
    delaysMs: REMOTE_RUNTIME_SHARED_CONTROL_RECONNECT_DELAYS_MS,
    open: () => {
      // Why: a cancelled timer may still fire after a replacement is queued.
      if (timer === null || args.getCurrentTimer() !== timer) {
        return
      }
      args.onTimerFired()
      if (args.subscriptions.size === 0 || args.isIntentionallyClosed()) {
        return
      }
      args.open()
    }
  })
  timer = scheduled.timer
  return scheduled
}

export function handleSharedControlDisconnect(
  error: RemoteRuntimeClientError,
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>,
  intentionallyClosed: boolean,
  clearReconnectTimer: () => void
): boolean {
  if (subscriptions.size === 0 || intentionallyClosed) {
    return false
  }
  if (isRecoverableRemoteRuntimeConnectionError(error)) {
    return true
  }
  clearReconnectTimer()
  finishSharedControlSubscriptions(subscriptions, true, error)
  return false
}
