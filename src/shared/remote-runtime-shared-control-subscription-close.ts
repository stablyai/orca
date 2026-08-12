import type { SharedControlRetiredRequestIds } from './remote-runtime-shared-control-retired-request-ids'
import {
  closeSharedControlLogicalSubscription,
  sendSharedControlCleanupRequest
} from './remote-runtime-shared-control-subscriptions'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

export function closeSharedControlConnectionSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  requestId: string
  deviceToken: string
  send: (payload: unknown) => boolean
}): void {
  const subscription = args.subscriptions.get(args.requestId)
  closeSharedControlLogicalSubscription({
    subscriptions: args.subscriptions,
    subscription,
    request: (method, params) =>
      sendRetiredSharedControlCleanupRequest({
        retiredRequestIds: args.retiredRequestIds,
        deviceToken: args.deviceToken,
        method,
        params,
        send: args.send
      })
  })
  if (subscription && !args.subscriptions.has(args.requestId)) {
    args.retiredRequestIds.retire(args.requestId)
  }
}

export function sendRetiredSharedControlCleanupRequest(args: {
  retiredRequestIds: SharedControlRetiredRequestIds
  deviceToken: string
  method: string
  params: unknown
  send: (payload: unknown) => boolean
}): void {
  const requestId = sendSharedControlCleanupRequest(args)
  if (requestId) {
    args.retiredRequestIds.retire(requestId)
  }
}
