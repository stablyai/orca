import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import {
  takeRemoteRuntimePreparedRequest,
  toRemoteRuntimeRequestError
} from '../requests/remote-runtime-prepared-request-admission'
import { finishSharedControlSubscription } from './remote-runtime-shared-control-state'
import type {
  SharedControlLogicalSubscription,
  SharedControlPendingRequest
} from './remote-runtime-shared-control-types'

export function sendSharedControlRequest(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  requestId: string
  send: (serializedRequest: string, beforeSend?: () => void, onSendAttempt?: () => void) => boolean
  reject: (requestId: string, error: Error) => void
}): void {
  const pending = args.pendingRequests.get(args.requestId)
  if (!pending) {
    return
  }
  const serializedRequest = takeRemoteRuntimePreparedRequest(pending)
  let sent: boolean
  try {
    sent =
      serializedRequest !== null &&
      args.send(serializedRequest, pending.assertInTime, pending.onFrameSent)
  } catch (error) {
    // Its end passed once sealed: refused unsent, this request only.
    args.reject(args.requestId, toRemoteRuntimeRequestError(error))
    return
  }
  if (!sent) {
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
