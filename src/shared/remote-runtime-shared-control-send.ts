import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { takeRemoteRuntimePreparedRequest } from './remote-runtime-prepared-request-admission'
import { finishSharedControlSubscription } from './remote-runtime-shared-control-state'
import type {
  SharedControlLogicalSubscription,
  SharedControlPendingRequest
} from './remote-runtime-shared-control-types'

export function sendSharedControlRequest(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  requestId: string
  send: (serializedRequest: string) => boolean
  reject: (requestId: string, error: Error) => void
}): void {
  const pending = args.pendingRequests.get(args.requestId)
  if (!pending) {
    return
  }
  const serializedRequest = takeRemoteRuntimePreparedRequest(pending)
  if (serializedRequest === null || !args.send(serializedRequest)) {
    args.reject(args.requestId, remoteRuntimeUnavailableError())
  }
}

export function sendSharedControlSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  subscription: SharedControlLogicalSubscription<unknown>
  deviceToken: string
  send: (payload: unknown) => boolean
}): void {
  if (args.subscription.closed || args.subscription.sent) {
    return
  }
  if (
    args.send({
      id: args.subscription.requestId,
      deviceToken: args.deviceToken,
      method: args.subscription.method,
      params: args.subscription.params
    })
  ) {
    args.subscription.sent = true
    return
  }
  finishSharedControlSubscription(
    args.subscriptions,
    args.subscription,
    true,
    remoteRuntimeUnavailableError()
  )
}
