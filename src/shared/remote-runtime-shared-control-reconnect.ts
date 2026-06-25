import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import {
  finishSharedControlSubscription,
  scheduleSharedControlReconnect
} from './remote-runtime-shared-control-state'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

export function scheduleSharedControlReconnectOrFinish(args: {
  current: ReturnType<typeof setTimeout> | null
  intentionallyClosed: boolean
  reconnectAttempt: number
  delaysMs: readonly number[]
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  open: () => void
}): { timer: ReturnType<typeof setTimeout> | null; reconnectAttempt: number } {
  if (args.reconnectAttempt >= args.delaysMs.length) {
    const error = remoteRuntimeUnavailableError(
      'Remote Orca runtime connection could not be restored.'
    )
    for (const subscription of Array.from(args.subscriptions.values())) {
      finishSharedControlSubscription(args.subscriptions, subscription, true, error)
    }
    return { timer: null, reconnectAttempt: args.reconnectAttempt }
  }
  return scheduleSharedControlReconnect(args)
}
