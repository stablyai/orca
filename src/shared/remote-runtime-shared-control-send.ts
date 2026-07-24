import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { finishSharedControlSubscription } from './remote-runtime-shared-control-state'
import type {
  SharedControlLogicalSubscription,
  SharedControlPendingRequest
} from './remote-runtime-shared-control-types'

export function sendSharedControlRequest(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  requestId: string
  deviceToken: string
  method: string
  params: unknown
  send: (payload: unknown) => boolean
  reject: (requestId: string, error: Error) => void
}): void {
  if (!args.pendingRequests.has(args.requestId)) {
    return
  }
  if (
    !args.send({
      id: args.requestId,
      deviceToken: args.deviceToken,
      method: args.method,
      params: args.params
    })
  ) {
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
