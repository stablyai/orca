import { handleSharedControlTextFrame } from './remote-runtime-shared-control-frame-handler'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import type { RuntimeCapability } from './protocol-version'
import type {
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlReadyWaiter
} from './remote-runtime-shared-control-types'
import type { SharedControlRetiredRequestIds } from './remote-runtime-shared-control-retired-request-ids'

export function handleRuntimeControlTextFrame(args: {
  frame: string
  socketGeneration: number
  isCurrent: (generation: number) => boolean
  getState: () => SharedControlConnectionState
  getSharedKey: () => Uint8Array | null
  environmentId?: string
  deviceToken: string
  clientCapabilities: readonly RuntimeCapability[]
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  readyWaiters: SharedControlReadyWaiter[]
  setState: (state: SharedControlConnectionState) => void
  handleSocketClosed: (error: RemoteRuntimeClientError) => void
  sendEncrypted: (payload: unknown) => boolean
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
    sharedKey: args.getSharedKey(),
    environmentId: args.environmentId,
    deviceToken: args.deviceToken,
    clientCapabilities: args.clientCapabilities,
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
    markReady: args.markReady,
    replaySubscriptions: args.replaySubscriptions
  })
}
