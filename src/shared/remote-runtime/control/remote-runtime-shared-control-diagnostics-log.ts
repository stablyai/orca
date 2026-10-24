import type {
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest
} from './remote-runtime-shared-control-types'

export function logSharedControlSocketClose(args: {
  environmentId?: string
  state: SharedControlConnectionState
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  lastClose: { code: number; reason: string } | null
  error?: Error
}): void {
  if (!args.error && !args.lastClose) {
    return
  }
  console.warn('[remote-runtime.shared-control] socket closed', {
    environmentId: args.environmentId ?? 'unknown',
    state: args.state,
    pendingMethods: Array.from(args.pendingRequests.values()).map((request) => request.method),
    subscriptionMethods: Array.from(args.subscriptions.values()).map(
      (subscription) => subscription.method
    ),
    lastClose: args.lastClose,
    error: args.error?.message ?? null
  })
}

export function logUnknownSharedControlResponse(args: {
  environmentId?: string
  responseId: string
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
}): void {
  console.warn('[remote-runtime.shared-control] unknown response id', {
    environmentId: args.environmentId ?? 'unknown',
    responseId: args.responseId,
    pendingMethods: Array.from(args.pendingRequests.values()).map((request) => request.method),
    subscriptionMethods: Array.from(args.subscriptions.values()).map(
      (subscription) => subscription.method
    )
  })
}
