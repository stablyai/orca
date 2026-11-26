import {
  invalidRemoteRuntimeResponseError,
  parseRemoteRuntimeRpcFrame
} from '../requests/remote-runtime-request-frames'
import type { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { SEALED_FRAME_FAILURE_MESSAGES } from '../remote-runtime-sealed-frame'
import type { SharedControlBinaryChannels } from './remote-runtime-shared-control-binary-channels'
import { logUnknownSharedControlResponse } from './remote-runtime-shared-control-diagnostics-log'
import type { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'
import { sendRetiredSharedControlCleanupRequest } from '../requests/remote-runtime-shared-control-subscription-close'
import { handleSharedControlLogicalResponse } from '../requests/remote-runtime-shared-control-subscriptions'
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
  retiredRequestIds: SharedControlRetiredRequestIds
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
        sendRetiredSharedControlCleanupRequest({
          retiredRequestIds: args.retiredRequestIds,
          deviceToken: args.deviceToken,
          method,
          params,
          send: args.send
        })
    })
    if (!args.subscriptions.has(response.id)) {
      args.retiredRequestIds.retire(response.id)
    }
    return
  }

  if (args.pendingRequests.has(response.id)) {
    resolveSharedControlPendingResponse(args.pendingRequests, response.id, response)
    args.retiredRequestIds.retire(response.id)
    return
  }

  if (args.retiredRequestIds.has(response.id)) {
    return
  }

  logUnknownSharedControlResponse({
    environmentId: args.environmentId,
    responseId: response.id,
    pendingRequests: args.pendingRequests,
    subscriptions: args.subscriptions
  })
}

/** One authenticated frame: text is a reply or stream event; binary is a channel's, if any. */
export function readSharedControlChannelFrame(
  frame: string | Uint8Array<ArrayBufferLike>,
  args: Omit<Parameters<typeof dispatchSharedControlFrame>[0], 'frame'> & {
    binaryChannels: SharedControlBinaryChannels | null
    fail: (error: RemoteRuntimeClientError) => void
  }
): void {
  if (typeof frame !== 'string') {
    // Without binary channels a control socket carries text only, as it always has.
    if (!args.binaryChannels?.deliver(frame)) {
      args.fail(invalidRemoteRuntimeResponseError(SEALED_FRAME_FAILURE_MESSAGES.unexpected_binary))
    }
    return
  }
  const parsed = parseRemoteRuntimeRpcFrame(frame)
  if (parsed.type === 'error') {
    args.fail(parsed.error)
    return
  }
  dispatchSharedControlFrame({ ...args, frame: parsed })
}
