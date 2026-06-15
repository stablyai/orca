import { parseAuthenticatedFrame, parseReadyFrame } from './remote-runtime-request-frames'
import type { RemoteRuntimeClientError } from './remote-runtime-client'
import { dispatchSharedControlFrame } from './remote-runtime-shared-control-frame-dispatch'
import { parseSharedControlFrame } from './remote-runtime-shared-control-protocol'
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
  sharedKey: Uint8Array | null
  deviceToken: string
  environmentId?: string
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  readyWaiters: SharedControlReadyWaiter[]
  setState: (state: SharedControlConnectionState) => void
  handleSocketClosed: (error: RemoteRuntimeClientError) => void
  sendEncrypted: (payload: unknown) => boolean
  markReady: () => void
  replaySubscriptions: () => void
}): void {
  if (args.state === 'awaiting_ready') {
    const error = parseReadyFrame(args.frame)
    if (error) {
      args.handleSocketClosed(error)
      return
    }
    args.setState('awaiting_authenticated')
    args.sendEncrypted({ type: 'e2ee_auth', deviceToken: args.deviceToken })
    return
  }

  const parsed = parseSharedControlFrame(args.frame, args.sharedKey, args.state)
  if (parsed.type === 'auth') {
    const error = parseAuthenticatedFrame(parsed.plaintext)
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
    deviceToken: args.deviceToken,
    send: args.sendEncrypted
  })
}
