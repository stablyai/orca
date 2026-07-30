import { randomUUID } from 'node:crypto'
import { serializeRemoteRuntimeRpcRequest } from './remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  type RemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import { remoteRuntimeTimeoutError } from './remote-runtime-request-frames'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
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
  ensureReady: () => Promise<void>
  send: (requestId: string) => void
  // Why: default off — ordinary short RPCs keep an absolute deadline. Only
  // long-polls routed through this path opt in so keepalives extend them.
  refreshTimeoutOnKeepalive?: boolean
}): Promise<RuntimeRpcResponse<TResult>> {
  const { ensureReady, pendingRequests, send } = args
  const requestId = randomUUID()
  let preparedRequest: RemoteRuntimePreparedRequest
  try {
    preparedRequest = prepareRemoteRuntimeRequest(pendingRequests, () =>
      serializeRemoteRuntimeRpcRequest({
        requestId,
        deviceToken: args.deviceToken,
        method: args.method,
        params: args.params
      })
    )
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingRequests.get(requestId)
      if (!pending) {
        return
      }
      pendingRequests.delete(requestId)
      releaseRemoteRuntimePreparedRequest(pending)
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
