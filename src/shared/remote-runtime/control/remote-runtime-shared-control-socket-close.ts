import type { AuthenticatedRuntimeChannel } from './remote-runtime-authenticated-channel'
import { logSharedControlSocketClose } from './remote-runtime-shared-control-diagnostics-log'
import {
  closeSharedControlSocketState,
  finishSharedControlSubscription
} from './remote-runtime-shared-control-state'
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
}): () => void {
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
  // A stream on a binary channel ends with the socket, as its own socket's stream did; the other
  // streams replay on the next socket. The caller tells their owners (the returned function) once
  // the close settled, so an owner reopening its stream finds this socket closed.
  const endedStreams = Array.from(args.subscriptions.values()).filter(
    (subscription) => subscription.binaryChannel !== undefined && subscription.sent
  )
  for (const stream of endedStreams) {
    finishSharedControlSubscription(args.subscriptions, stream, false)
  }
  closeSharedControlSocketState({
    readyWaiters: args.readyWaiters,
    pendingRequests: args.pendingRequests,
    subscriptions: args.subscriptions,
    channel: args.channel,
    error: args.error,
    preserveReadyWaitersAndPendingRequests: args.preserveReadyWaitersAndPendingRequests
  })
  return () => notifyChannelStreamsEnded(endedStreams)
}

/** The channel streams a closing connection ends; tell their owners with the returned function. */
export function channelStreamsEndedByClose(
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
): () => void {
  const streams = Array.from(subscriptions.values()).filter(
    (subscription) =>
      subscription.binaryChannel !== undefined && subscription.sent && !subscription.closed
  )
  return () => notifyChannelStreamsEnded(streams)
}

// One owner's throwing onClose must not keep the others from hearing, or stop the reconnect.
function notifyChannelStreamsEnded(streams: SharedControlLogicalSubscription<unknown>[]): void {
  for (const stream of streams) {
    try {
      stream.callbacks.onClose?.()
    } catch (error) {
      console.warn('[remote-runtime] a stream close handler failed', error)
    }
  }
}
