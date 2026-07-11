import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlReadyWaiter
} from './remote-runtime-shared-control-types'
import { getSubscriptionId, isEndResult } from './remote-runtime-shared-control-protocol'
import { tagRuntimeSubscriptionReplayResponse } from './runtime-subscription-replay'

export function buildSharedControlDiagnostics(args: {
  state: SharedControlConnectionState
  reconnecting: boolean
  pendingRequestCount: number
  subscriptionCount: number
  reconnectAttempt: number
  lastConnectedAt: number | null
  lastClose: { code: number; reason: string } | null
  lastError: string | null
}): RemoteRuntimeSharedConnectionDiagnostics {
  return {
    state: args.reconnecting ? 'reconnecting' : args.state,
    pendingRequestCount: args.pendingRequestCount,
    subscriptionCount: args.subscriptionCount,
    reconnectAttempt: args.reconnectAttempt,
    lastConnectedAt: args.lastConnectedAt,
    lastClose: args.lastClose,
    lastError: args.lastError
  }
}

export function rejectSharedControlPendingRequest(
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>,
  requestId: string,
  error: Error
): void {
  const pending = pendingRequests.get(requestId)
  if (!pending) {
    return
  }
  pendingRequests.delete(requestId)
  clearTimeout(pending.timeout)
  pending.reject(error)
}

export function resolveSharedControlPendingResponse(
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>,
  requestId: string,
  response: RuntimeRpcResponse<unknown>
): void {
  const pending = pendingRequests.get(requestId)
  if (!pending) {
    return
  }
  pendingRequests.delete(requestId)
  clearTimeout(pending.timeout)
  pending.resolve(response)
}

export function refreshSharedControlPendingRequestTimeouts(
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
): void {
  for (const pending of pendingRequests.values()) {
    // Why: only long-poll requests opted into keepalive refresh; refreshing an
    // ordinary short RPC would keep a genuinely-stuck server call alive forever.
    if (!pending.refreshTimeoutOnKeepalive) {
      continue
    }
    const timeout = pending.timeout as ReturnType<typeof setTimeout> & { refresh?: () => void }
    timeout.refresh?.()
  }
}

export function waitForSharedControlReady(ready: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(remoteRuntimeUnavailableError()), timeoutMs)
    void ready.then(
      () => {
        clearTimeout(timeout)
        resolve()
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

export function rejectAllSharedControlPendingRequests(
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>,
  error?: Error
): void {
  const closeError = error ?? remoteRuntimeUnavailableError()
  for (const [requestId, pending] of pendingRequests) {
    clearTimeout(pending.timeout)
    pendingRequests.delete(requestId)
    pending.reject(closeError)
  }
}

export function markSharedControlSubscriptionsUnsent(
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
): void {
  for (const subscription of subscriptions.values()) {
    subscription.sent = false
  }
}

export function finishSharedControlSubscription(
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>,
  subscription: SharedControlLogicalSubscription<unknown>,
  notifyClose: boolean,
  error?: RemoteRuntimeClientError
): void {
  if (subscription.closed) {
    return
  }
  subscription.closed = true
  subscriptions.delete(subscription.requestId)
  if (error) {
    subscription.callbacks.onError(error)
  }
  if (notifyClose) {
    subscription.callbacks.onClose?.()
  }
}

export function finishSharedControlSubscriptions(
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>,
  notifyClose: boolean,
  error?: RemoteRuntimeClientError
): void {
  const finished: SharedControlLogicalSubscription<unknown>[] = []
  for (const subscription of Array.from(subscriptions.values())) {
    if (subscription.closed) {
      continue
    }
    subscription.closed = true
    subscriptions.delete(subscription.requestId)
    finished.push(subscription)
  }
  // Why: fatal callbacks may throw or synchronously close the connection. All
  // owners are detached first and each notification is isolated from the rest.
  for (const subscription of finished) {
    if (error) {
      invokeSharedControlSubscriptionCallback(() => subscription.callbacks.onError(error))
    }
    if (notifyClose && subscription.callbacks.onClose) {
      invokeSharedControlSubscriptionCallback(subscription.callbacks.onClose)
    }
  }
}

export function resolveSharedControlReadyWaiters(waiters: SharedControlReadyWaiter[]): void {
  for (const waiter of waiters.splice(0)) {
    waiter.resolve()
  }
}

export function rejectSharedControlReadyWaiters(
  waiters: SharedControlReadyWaiter[],
  error: Error
): void {
  for (const waiter of waiters.splice(0)) {
    waiter.reject(error)
  }
}

export function handleSharedControlSubscriptionResponse(
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>,
  subscription: SharedControlLogicalSubscription<unknown>,
  response: RuntimeRpcResponse<unknown>
): void {
  // The replay window ends on either success or error. An error created no
  // remote subscription, so a later close must finish locally instead of
  // waiting forever for an id that will never arrive.
  subscription.awaitingResubscribe = false
  if (!response.ok) {
    subscription.sent = false
  }
  if (response.ok) {
    const subscriptionId = getSubscriptionId(response.result)
    if (subscriptionId) {
      subscription.remoteSubscriptionId = subscriptionId
    }
  }
  let delivered = response
  if (subscription.pendingReplayTag) {
    subscription.pendingReplayTag = false
    if (response.ok) {
      delivered = tagRuntimeSubscriptionReplayResponse(response)
    }
  }
  subscription.callbacks.onResponse(delivered)
  if (response.ok && isEndResult(response.result)) {
    finishSharedControlSubscription(subscriptions, subscription, false)
  }
}

export function closeSharedControlSocketState(args: {
  readyWaiters: SharedControlReadyWaiter[]
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  socketCleanup: (() => void) | null
  ws: { close: () => void } | null
  error?: Error
}): void {
  rejectSharedControlReadyWaiters(args.readyWaiters, args.error ?? remoteRuntimeUnavailableError())
  rejectAllSharedControlPendingRequests(args.pendingRequests, args.error)
  markSharedControlSubscriptionsUnsent(args.subscriptions)
  try {
    args.socketCleanup?.()
    args.ws?.close()
  } catch {
    // Best-effort cleanup of remote runtime control socket.
  }
}

export function scheduleSharedControlReconnect(args: {
  current: ReturnType<typeof setTimeout> | null
  intentionallyClosed: boolean
  reconnectAttempt: number
  delaysMs: readonly number[]
  open: () => void
}): { timer: ReturnType<typeof setTimeout> | null; reconnectAttempt: number } {
  if (args.current || args.intentionallyClosed) {
    return { timer: args.current, reconnectAttempt: args.reconnectAttempt }
  }
  const maximumDelayMs = args.delaysMs.at(-1)!
  const delay = Math.min(
    withReconnectJitter(args.delaysMs[Math.min(args.reconnectAttempt, args.delaysMs.length - 1)]),
    maximumDelayMs
  )
  const timer = setTimeout(args.open, delay)
  if (typeof timer.unref === 'function') {
    timer.unref()
  }
  return { timer, reconnectAttempt: args.reconnectAttempt + 1 }
}

function withReconnectJitter(delayMs: number): number {
  // Why: when a remote host restarts, all passive subscriptions reconnect
  // together. A small one-sided jitter avoids synchronized retry spikes.
  const jitterMs = Math.floor(delayMs * 0.2 * Math.random())
  return delayMs + jitterMs
}

function invokeSharedControlSubscriptionCallback(callback: () => void): void {
  try {
    callback()
  } catch {
    // Subscriber cleanup is best-effort; one consumer cannot starve the rest.
  }
}
