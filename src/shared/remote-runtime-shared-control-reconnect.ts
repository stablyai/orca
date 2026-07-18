import { scheduleSharedControlReconnect } from './remote-runtime-shared-control-state'

export function scheduleSharedControlReconnectUntilClosed(args: {
  current: ReturnType<typeof setTimeout> | null
  intentionallyClosed: boolean
  reconnectAttempt: number
  delaysMs: readonly number[]
  open: () => void
}): { timer: ReturnType<typeof setTimeout> | null; reconnectAttempt: number } {
  // Why: laptops can remain asleep or offline indefinitely. Passive subscriptions
  // must survive that gap and retry at the capped delay until explicitly closed.
  return scheduleSharedControlReconnect(args)
}
