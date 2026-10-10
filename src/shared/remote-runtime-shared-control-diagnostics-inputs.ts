import type { SharedControlConnectionState } from './remote-runtime-shared-control-types'
import type { SharedControlDiagnosticsTracker } from './remote-runtime-shared-control-diagnostics'
import type { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'

export function sharedControlDiagnosticsInputs(
  state: SharedControlConnectionState,
  reconnect: SharedControlReconnectScheduler,
  pendingRequests: ReadonlyMap<string, unknown>,
  subscriptions: ReadonlyMap<string, unknown>
): Parameters<SharedControlDiagnosticsTracker['get']>[0] {
  return {
    state,
    reconnecting: reconnect.isScheduled,
    pendingRequestCount: pendingRequests.size,
    subscriptionCount: subscriptions.size,
    reconnectAttempt: reconnect.attemptCount
  }
}
