import { randomUUID } from 'node:crypto'
import { abortSignalReason } from '../../abort-signal-reason'
import { serializeRemoteRuntimeRpcRequest } from '../remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  type RemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import { remoteRuntimeTimeoutError } from './remote-runtime-request-frames'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestPreparation,
  RuntimeRpcResponse
} from '../../runtime-rpc-envelope'
import { serializePreparedRemoteRuntimeRequest } from './remote-runtime-request-preparation'
import { toRemoteRuntimeClientError } from '../control/remote-runtime-shared-control-protocol'
import { rejectSharedControlPendingRequest } from '../control/remote-runtime-shared-control-state'
import type { SharedControlPendingRequest } from '../control/remote-runtime-shared-control-types'

const MAX_RETAINED_METHOD_CHARS = 256

export function requestSharedControl<TResult>(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  deviceToken: string
  method: string
  params: unknown
  timeoutMs: number
  envelope?: RuntimeOrchestrationEnvelope
  /** Picks the params actually sent, e.g. the prefix of a batch that fits the host's request bound. */
  prepareRequest?: RuntimeRequestPreparation
  ensureReady: () => Promise<void>
  send: (requestId: string) => void
  retireRequestId?: (requestId: string) => void
  signal?: AbortSignal
  // Only long-polls opt into keepalive refresh; short RPCs retain absolute deadlines.
  refreshTimeoutOnKeepalive?: boolean
  /** Runs once the socket is ready, just before sending; a throw rejects without sending. */
  beforeSend?: () => void
  prepareGuard?: () => Promise<() => boolean | void>
  captureSendGuard?: () => () => void
}): Promise<RuntimeRpcResponse<TResult>> {
  const { ensureReady, pendingRequests, send } = args
  if (args.signal?.aborted) {
    return Promise.reject(abortSignalReason(args.signal))
  }
  const requestId = randomUUID()
  let preparedRequest: RemoteRuntimePreparedRequest
  try {
    preparedRequest = prepareRemoteRuntimeRequest(pendingRequests, () =>
      serializePreparedRemoteRuntimeRequest(
        (params, envelope) =>
          serializeRemoteRuntimeRpcRequest({
            requestId,
            deviceToken: args.deviceToken,
            method: args.method,
            params,
            envelope
          }),
        args.params,
        args.envelope,
        args.prepareRequest
      )
    )
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
    const onAbort = (): void => {
      args.retireRequestId?.(requestId)
      rejectSharedControlPendingRequest(pendingRequests, requestId, abortSignalReason(args.signal!))
    }
    const deadline = performance.now() + args.timeoutMs
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
    const isCurrent = (): boolean => {
      if (pendingRequests.get(requestId) !== pending || args.signal?.aborted) {
        return false
      }
      if (performance.now() >= deadline) {
        rejectSharedControlPendingRequest(pendingRequests, requestId, remoteRuntimeTimeoutError())
        return false
      }
      return true
    }
    const run = async (): Promise<void> => {
      if (args.prepareGuard) {
        for (;;) {
          const commit = await args.prepareGuard()
          if (!isCurrent()) {
            return
          }
          if (commit() !== false) {
            break
          }
        }
      }
      try {
        await ensureReady()
      } catch (error) {
        throw toRemoteRuntimeClientError(error)
      }
      if (!isCurrent()) {
        return
      }
      const sendGuard = args.captureSendGuard?.()
      for (;;) {
        const commit = args.prepareGuard ? await args.prepareGuard() : undefined
        if (!isCurrent()) {
          return
        }
        try {
          sendGuard?.()
          args.beforeSend?.()
        } catch (error) {
          throw toRemoteRuntimeClientError(error)
        }
        if (commit?.() === false) {
          continue
        }
        send(requestId)
        break
      }
    }
    void run().catch((error: unknown) =>
      rejectSharedControlPendingRequest(
        pendingRequests,
        requestId,
        error instanceof Error ? error : new Error(String(error))
      )
    )
  })
}
