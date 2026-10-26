import type WebSocket from 'ws'
import { sendRemoteRuntimeTokenAuth } from '../../remote-runtime-client-handshake'
import { toRemoteRuntimeClientError } from './remote-runtime-shared-control-protocol'
import type { PairedE2EEClientHandshake } from '../../paired-e2ee-client-handshake'
import { handleSharedControlTextFrame } from './remote-runtime-shared-control-frame-handler'
import type { RemoteRuntimeClientError } from '../../remote-runtime-client-error'
import type {
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlReadyWaiter
} from './remote-runtime-shared-control-types'
import type { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'

export function handleRuntimeControlTextFrame(args: {
  frame: string
  socketGeneration: number
  isCurrent: (generation: number) => boolean
  getState: () => SharedControlConnectionState
  getHandshake: () => PairedE2EEClientHandshake | null
  environmentId?: string
  deviceToken: string
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  readyWaiters: SharedControlReadyWaiter[]
  setState: (state: SharedControlConnectionState) => void
  handleSocketClosed: (error: RemoteRuntimeClientError) => void
  sendEncrypted: (payload: unknown) => boolean
  clientCapabilities: readonly string[]
  getSocket: () => WebSocket | null
  markReady: () => void
  replaySubscriptions: () => void
  publishDiagnostics: () => void
}): void {
  if (!args.isCurrent(args.socketGeneration)) {
    return
  }
  handleSharedControlTextFrame({
    frame: args.frame,
    state: args.getState(),
    handshake: args.getHandshake(),
    environmentId: args.environmentId,
    deviceToken: args.deviceToken,
    pendingRequests: args.pendingRequests,
    subscriptions: args.subscriptions,
    retiredRequestIds: args.retiredRequestIds,
    readyWaiters: args.readyWaiters,
    setState: (state) => {
      args.setState(state)
      args.publishDiagnostics()
    },
    handleSocketClosed: args.handleSocketClosed,
    sendEncrypted: args.sendEncrypted,
    sendAuth: (handshake) =>
      void sendRemoteRuntimeTokenAuth({
        handshake,
        deviceToken: args.deviceToken,
        clientCapabilities: args.clientCapabilities,
        stillAwaiting: () =>
          args.getHandshake() === handshake &&
          args.getState() === 'awaiting_authenticated' &&
          args.getSocket()?.readyState === 1,
        send: (frame) => args.getSocket()?.send(frame),
        fail: (error) => args.handleSocketClosed(toRemoteRuntimeClientError(error))
      }),
    markReady: args.markReady,
    replaySubscriptions: args.replaySubscriptions
  })
}
