import type { AuthenticatedRuntimeChannel } from './remote-runtime-authenticated-channel'
import { logSharedControlSocketClose } from './remote-runtime-shared-control-diagnostics-log'
import { closeSharedControlSocketState } from './remote-runtime-shared-control-state'
import { finishCloseAfterReadySubscriptions } from '../requests/remote-runtime-shared-control-subscriptions'
import type {
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlReadyWaiter,
  SharedControlSocketClose
} from './remote-runtime-shared-control-types'

export const LOCAL_CLOSE: SharedControlSocketClose = { cause: 'local', errorCode: null }

export function closeSharedControlSocket(args: {
  /** Records the close cause; runs only when a socket existed, like the log below. */
  reportClose: () => void
  environmentId?: string
  state: SharedControlConnectionState
  channel: AuthenticatedRuntimeChannel | null
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  readyWaiters: SharedControlReadyWaiter[]
  lastClose: { code: number; reason: string } | null
  error?: Error
  preserveReadyWaitersAndPendingRequests?: boolean
  clearReadinessTimer: () => void
}): void {
  if (args.channel) {
    args.reportClose()
    logSharedControlSocketClose({
      environmentId: args.environmentId ?? 'unknown',
      state: args.state,
      pendingRequests: args.pendingRequests,
      subscriptions: args.subscriptions,
      lastClose: args.lastClose,
      error: args.error
    })
  }
  args.clearReadinessTimer()
  finishCloseAfterReadySubscriptions(args.subscriptions)
  closeSharedControlSocketState({
    readyWaiters: args.readyWaiters,
    pendingRequests: args.pendingRequests,
    subscriptions: args.subscriptions,
    channel: args.channel,
    error: args.error,
    preserveReadyWaitersAndPendingRequests: args.preserveReadyWaitersAndPendingRequests
  })
}
