import { randomUUID } from 'node:crypto'
import { abortSignalReason } from './abort-signal-reason'
import { serializeRemoteRuntimeRpcRequest } from './remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  type RemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import { remoteRuntimeTimeoutError } from './remote-runtime-request-frames'
import type { RuntimeOrchestrationEnvelope, RuntimeRpcResponse } from './runtime-rpc-envelope'
import { toRemoteRuntimeClientError } from './remote-runtime-shared-control-protocol'
import { rejectSharedControlPendingRequest } from './remote-runtime-shared-control-state'
import type { SharedControlPendingRequest } from './remote-runtime-shared-control-types'

const MAX_RETAINED_METHOD_CHARS = 256

export function requestSharedControl<TResult>(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  deviceToken: string
  method: string
  params: unknown
  timeoutMs: number
  envelope?: RuntimeOrchestrationEnvelope
  ensureReady: () => Promise<void>
  send: (requestId: string) => void
  retireRequestId?: (requestId: string) => void
  signal?: AbortSignal
  // Why: default off — ordinary short RPCs keep an absolute deadline. Only
  // long-polls routed through this path opt in so keepalives extend them.
  refreshTimeoutOnKeepalive?: boolean
}): Promise<RuntimeRpcResponse<TResult>> {
  const { ensureReady, pendingRequests, send } = args
  if (args.signal?.aborted) {
    return Promise.reject(abortSignalReason(args.signal))
  }
  const requestId = randomUUID()
  let preparedRequest: RemoteRuntimePreparedRequest
  try {
    preparedRequest = prepareRemoteRuntimeRequest(pendingRequests, () =>
      serializeRemoteRuntimeRpcRequest({
        requestId,
        deviceToken: args.deviceToken,
        method: args.method,
        params: args.params,
        envelope: args.envelope
      })
    )
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
    const onAbort = (): void => {
      args.retireRequestId?.(requestId)
      rejectSharedControlPendingRequest(pendingRequests, requestId, abortSignalReason(args.signal!))
    }
    const timeout = setTimeout(() => {
      const pending = pendingRequests.get(requestId)
      if (!pending) {
        return
      }
      pendingRequests.delete(requestId)
      releaseRemoteRuntimePreparedRequest(pending)
      args.retireRequestId?.(requestId)
      // Why: one stalled method does not prove the shared socket is dead;
      // socket liveness owns connection-wide teardown so other RPCs survive.
      pending.reject(remoteRuntimeTimeoutError())
    }, args.timeoutMs)
    pendingRequests.set(requestId, {
      method: args.method.slice(0, MAX_RETAINED_METHOD_CHARS),
      resolve: resolve as (response: RuntimeRpcResponse<unknown>) => void,
      reject,
      timeout,
      preparedRequest,
      refreshTimeoutOnKeepalive: args.refreshTimeoutOnKeepalive ?? false
    })
    args.signal?.addEventListener('abort', onAbort, { once: true })
    const removeAbortListener = (): void => args.signal?.removeEventListener('abort', onAbort)
    const pending = pendingRequests.get(requestId)
    if (pending) {
      const resolvePending = pending.resolve
      const rejectPending = pending.reject
      pending.resolve = (response) => {
        removeAbortListener()
        resolvePending(response)
      }
      pending.reject = (error) => {
        removeAbortListener()
        rejectPending(error)
      }
    }
    if (args.signal?.aborted) {
      onAbort()
      return
    }
    void ensureReady().then(
      () => send(requestId),
      (error) =>
        rejectSharedControlPendingRequest(
          pendingRequests,
          requestId,
          toRemoteRuntimeClientError(error)
        )
    )
  })
}
