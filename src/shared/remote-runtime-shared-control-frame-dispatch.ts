import type { parseRemoteRuntimeRpcFrame } from './remote-runtime-request-frames'
import { logUnknownSharedControlResponse } from './remote-runtime-shared-control-diagnostics-log'
import {
  handleSharedControlLogicalResponse,
  sendSharedControlCleanupRequest
} from './remote-runtime-shared-control-subscriptions'
import {
  refreshSharedControlPendingRequestTimeouts,
  resolveSharedControlPendingResponse
} from './remote-runtime-shared-control-state'
import type {
  SharedControlLogicalSubscription,
  SharedControlPendingRequest
} from './remote-runtime-shared-control-types'

type SharedControlFrame = Exclude<ReturnType<typeof parseRemoteRuntimeRpcFrame>, { type: 'error' }>

export function dispatchSharedControlFrame(args: {
  environmentId?: string
  frame: SharedControlFrame
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  deviceToken: string
  send: (payload: unknown) => boolean
}): void {
  if (args.frame.type === 'keepalive') {
    refreshSharedControlPendingRequestTimeouts(args.pendingRequests)
    return
  }

  const response = args.frame.response
  const subscription = args.subscriptions.get(response.id)
  if (subscription) {
    handleSharedControlLogicalResponse({
      subscriptions: args.subscriptions,
      subscription,
      response,
      request: (method, params) =>
        sendSharedControlCleanupRequest({
          deviceToken: args.deviceToken,
          method,
          params,
          send: args.send
        })
    })
    return
  }

  if (args.pendingRequests.has(response.id)) {
    resolveSharedControlPendingResponse(args.pendingRequests, response.id, response)
    return
  }

  logUnknownSharedControlResponse({
    environmentId: args.environmentId,
    responseId: response.id,
    pendingRequests: args.pendingRequests,
    subscriptions: args.subscriptions
  })
}
