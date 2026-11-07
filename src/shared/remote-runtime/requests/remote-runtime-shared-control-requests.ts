import { randomUUID } from 'node:crypto'
import { abortSignalReason } from '../../abort-signal-reason'
import { serializeRemoteRuntimeRpcRequest } from '../remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequestAtHandoff,
  type RemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import { remoteRuntimeTimeoutError } from './remote-runtime-request-frames'
import type { RuntimeOrchestrationEnvelope, RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import { toRemoteRuntimeClientError } from '../control/remote-runtime-shared-control-protocol'
import { rejectSharedControlPendingRequest } from '../control/remote-runtime-shared-control-state'
import type { SharedControlPendingRequest } from '../control/remote-runtime-shared-control-types'
import {
  remoteRuntimeRequestDispatchCutoff,
  remoteRuntimeRequestDispatchObserver
} from './remote-runtime-request-dispatch-observation'

const MAX_RETAINED_METHOD_CHARS = 256

export function requestSharedControl<TResult>(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  deviceToken: string
  method: string
  params: unknown
  timeoutMs: number
  envelope?: RuntimeOrchestrationEnvelope
  /** Waits for the socket; `signal` withdraws this request's wait once the request is settled. */
  ensureReady: (signal: AbortSignal) => Promise<void>
  send: (requestId: string) => void
  retireRequestId?: (requestId: string) => void
  signal?: AbortSignal
  // Only long-polls opt into keepalive refresh; short RPCs retain absolute deadlines.
  refreshTimeoutOnKeepalive?: boolean
  /** Runs once the socket is ready, just before sending; a throw rejects without sending. */
  beforeSend?: () => void
}): Promise<RuntimeRpcResponse<TResult>> {
  const { ensureReady, pendingRequests, send } = args
  if (args.signal?.aborted) {
    return Promise.reject(abortSignalReason(args.signal))
  }
  const requestId = randomUUID()
  const serialize = (params: unknown): string =>
    serializeRemoteRuntimeRpcRequest({
      requestId,
      deviceToken: args.deviceToken,
      method: args.method,
      params,
      envelope: args.envelope
    })
  let preparedRequest: RemoteRuntimePreparedRequest
  try {
    preparedRequest = prepareRemoteRuntimeRequest(pendingRequests, () => serialize(args.params))
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
      refreshTimeoutOnKeepalive: args.refreshTimeoutOnKeepalive ?? false,
      onFrameSent: remoteRuntimeRequestDispatchObserver(args.params),
      assertInTime: remoteRuntimeRequestDispatchCutoff(args.params)
    })
    args.signal?.addEventListener('abort', onAbort, { once: true })
    // However it settles, its wait for readiness goes too: nothing keeps its continuation or params.
    const readiness = new AbortController()
    const detachWaits = (): void => {
      args.signal?.removeEventListener('abort', onAbort)
      readiness.abort()
    }
    const pending = pendingRequests.get(requestId)
    if (pending) {
      const resolvePending = pending.resolve
      const rejectPending = pending.reject
      pending.resolve = (response) => {
        detachWaits()
        resolvePending(response)
      }
      pending.reject = (error) => {
        detachWaits()
        rejectPending(error)
      }
    }
    if (args.signal?.aborted) {
      onAbort()
      return
    }
    void ensureReady(readiness.signal).then(
      () => {
        try {
          args.beforeSend?.()
          // Its bytes are chosen now, after readiness: the early ones cannot carry its budget.
          const ready = pendingRequests.get(requestId)
          const request = ready
            ? takeRemoteRuntimePreparedRequestAtHandoff(ready, args.params, serialize)
            : null
          if (ready?.preparedRequest && request !== null) {
            ready.preparedRequest.serializedRequest = request
          }
        } catch (error) {
          rejectSharedControlPendingRequest(
            pendingRequests,
            requestId,
            toRemoteRuntimeClientError(error)
          )
          return
        }
        send(requestId)
      },
      (error) =>
        rejectSharedControlPendingRequest(
          pendingRequests,
          requestId,
          toRemoteRuntimeClientError(error)
        )
    )
  })
}
