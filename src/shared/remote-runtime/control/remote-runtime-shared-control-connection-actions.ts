import * as sharedControlProtocol from './remote-runtime-shared-control-protocol'
import * as sharedControlState from './remote-runtime-shared-control-state'

import * as sharedControlSubscriptions from '../requests/remote-runtime-shared-control-subscriptions'
import * as sharedControlSend from './remote-runtime-shared-control-send'
import type {
  SharedControlLogicalSubscription,
  SharedControlPendingRequest
} from './remote-runtime-shared-control-types'

export function sendSharedControlRequest(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  requestId: string
  state: Parameters<typeof sharedControlProtocol.sendSharedControlEncryptedSerialized>[0]['state']
  ws: Parameters<typeof sharedControlProtocol.sendSharedControlEncryptedSerialized>[0]['ws']
  handshake: Parameters<
    typeof sharedControlProtocol.sendSharedControlEncryptedSerialized
  >[0]['handshake']
}): void {
  sharedControlSend.sendSharedControlRequest({
    pendingRequests: args.pendingRequests,
    requestId: args.requestId,
    send: (serialized) =>
      sharedControlProtocol.sendSharedControlEncryptedSerialized({
        state: args.state,
        ws: args.ws,
        handshake: args.handshake,
        serialized
      }),
    reject: (id, error) =>
      sharedControlState.rejectSharedControlPendingRequest(args.pendingRequests, id, error)
  })
}

export function replaySharedControlSubscriptions(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  send: (subscription: SharedControlLogicalSubscription<unknown>) => void
  tagReplayedResponses: boolean
}): boolean {
  sharedControlSubscriptions.replaySharedControlSubscriptions(args)
  return true
}

export function replayRuntimeControlSubscriptions(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  deviceToken: string
  send: (payload: unknown) => boolean
  tagReplayedResponses: boolean
}): boolean {
  return replaySharedControlSubscriptions({
    subscriptions: args.subscriptions,
    send: (subscription) =>
      sharedControlSend.sendSharedControlSubscription({
        subscriptions: args.subscriptions,
        subscription,
        deviceToken: args.deviceToken,
        send: args.send
      }),
    tagReplayedResponses: args.tagReplayedResponses
  })
}
