import type { PairedE2EEClientHandshake } from '../../paired-e2ee-client-handshake'
import {
  remoteRuntimeAuthReplyError,
  remoteRuntimeReadyError,
  remoteRuntimeUnavailableError
} from '../requests/remote-runtime-request-frames'
import type { RemoteRuntimeClientError } from '../../remote-runtime-client-error'
import { dispatchSharedControlFrame } from './remote-runtime-shared-control-frame-dispatch'
import { parseSharedControlFrame } from './remote-runtime-shared-control-protocol'
import type { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'
import { resolveSharedControlReadyWaiters } from './remote-runtime-shared-control-state'
import type {
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlReadyWaiter
} from './remote-runtime-shared-control-types'

export function handleSharedControlTextFrame(args: {
  frame: string
  state: SharedControlConnectionState
  handshake: PairedE2EEClientHandshake | null
  deviceToken: string
  environmentId?: string
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  readyWaiters: SharedControlReadyWaiter[]
  setState: (state: SharedControlConnectionState) => void
  handleSocketClosed: (error: RemoteRuntimeClientError) => void
  sendEncrypted: (payload: unknown) => boolean
  // Seals and sends this socket's auth frame (asynchronously).
  sendAuth: (handshake: PairedE2EEClientHandshake) => void
  markReady: () => void
  replaySubscriptions: () => void
}): void {
  if (args.state === 'awaiting_ready') {
    const handshake = args.handshake
    const error = handshake
      ? remoteRuntimeReadyError(handshake.acceptReadyText(args.frame))
      : remoteRuntimeUnavailableError()
    if (error || !handshake) {
      args.handleSocketClosed(error ?? remoteRuntimeUnavailableError())
      return
    }
    args.setState('awaiting_authenticated')
    args.sendAuth(handshake)
    return
  }

  const parsed = parseSharedControlFrame(args.frame, args.handshake, args.state)
  if (parsed.type === 'auth') {
    const error = args.handshake
      ? remoteRuntimeAuthReplyError(args.handshake.classifyAuthReply(parsed.plaintext))
      : remoteRuntimeUnavailableError()
    if (error) {
      args.handleSocketClosed(error)
      return
    }
    args.setState('ready')
    args.markReady()
    resolveSharedControlReadyWaiters(args.readyWaiters)
    args.replaySubscriptions()
    return
  }

  if (parsed.type === 'error') {
    args.handleSocketClosed(parsed.error)
    return
  }

  dispatchSharedControlFrame({
    environmentId: args.environmentId,
    frame: parsed.frame,
    pendingRequests: args.pendingRequests,
    subscriptions: args.subscriptions,
    retiredRequestIds: args.retiredRequestIds,
    deviceToken: args.deviceToken,
    send: args.sendEncrypted
  })
}
