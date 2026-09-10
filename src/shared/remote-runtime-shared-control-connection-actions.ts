import * as sharedControlProtocol from './remote-runtime-shared-control-protocol'
import * as sharedControlState from './remote-runtime-shared-control-state'
import { closeSharedControlConnectionSubscription } from './remote-runtime-shared-control-subscription-close'
import * as sharedControlSubscriptions from './remote-runtime-shared-control-subscriptions'
import * as sharedControlSend from './remote-runtime-shared-control-send'
import type {
  SharedControlLogicalSubscription,
  SharedControlPendingRequest
} from './remote-runtime-shared-control-types'
import type { SharedControlRetiredRequestIds } from './remote-runtime-shared-control-retired-request-ids'

export function sendSharedControlRequest(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  requestId: string
  state: Parameters<typeof sharedControlProtocol.sendSharedControlEncryptedSerialized>[0]['state']
  ws: Parameters<typeof sharedControlProtocol.sendSharedControlEncryptedSerialized>[0]['ws']
  sharedKey: Parameters<
    typeof sharedControlProtocol.sendSharedControlEncryptedSerialized
  >[0]['sharedKey']
}): void {
  sharedControlSend.sendSharedControlRequest({
    pendingRequests: args.pendingRequests,
    requestId: args.requestId,
    send: (serialized) =>
      sharedControlProtocol.sendSharedControlEncryptedSerialized({
        state: args.state,
        ws: args.ws,
        sharedKey: args.sharedKey,
        serialized
      }),
    reject: (id, error) =>
      sharedControlState.rejectSharedControlPendingRequest(args.pendingRequests, id, error)
  })
}

export function sendSharedControlSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  subscription: SharedControlLogicalSubscription<unknown>
  deviceToken: string
  send: (payload: unknown) => boolean
}): void {
  sharedControlSend.sendSharedControlSubscription(args)
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
      sendSharedControlSubscription({
        subscriptions: args.subscriptions,
        subscription,
        deviceToken: args.deviceToken,
        send: args.send
      }),
    tagReplayedResponses: args.tagReplayedResponses
  })
}

export function closeSharedControlSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  requestId: string
  deviceToken: string
  send: (payload: unknown) => boolean
}): void {
  closeSharedControlConnectionSubscription(args)
}

export function closeRuntimeControlSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  requestId: string
  deviceToken: string
  send: (payload: unknown) => boolean
  clearWhenIdle: (isIdle: boolean) => void
}): void {
  closeSharedControlSubscription(args)
  args.clearWhenIdle(args.subscriptions.size === 0)
}
