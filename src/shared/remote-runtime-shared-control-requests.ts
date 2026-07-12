import { randomUUID } from 'node:crypto'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  remoteRuntimeTimeoutError,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import { toRemoteRuntimeClientError } from './remote-runtime-shared-control-protocol'
import { rejectSharedControlPendingRequest } from './remote-runtime-shared-control-state'
import type { SharedControlPendingRequest } from './remote-runtime-shared-control-types'

export function requestSharedControl<TResult>(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  method: string
  params: unknown
  timeoutMs: number
  ensureReady: () => Promise<void>
  send: (requestId: string, method: string, params: unknown) => void
  onTimeout?: (error: RemoteRuntimeClientError) => void
  // Why: default off — ordinary short RPCs keep an absolute deadline. Only
  // long-polls routed through this path opt in so keepalives extend them.
  refreshTimeoutOnKeepalive?: boolean
}): Promise<RuntimeRpcResponse<TResult>> {
  const requestId = randomUUID()
  return new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = args.pendingRequests.get(requestId)
      if (!pending) {
        return
      }
      args.pendingRequests.delete(requestId)
      pending.reject(remoteRuntimeTimeoutError())
      // Why: a request the server never answered means the socket is suspect
      // (half-open tunnels swallow frames silently); mirror
      // RemoteRuntimeRequestConnection and hand the connection a teardown
      // error so reconnect+replay runs instead of keeping a zombie socket.
      args.onTimeout?.(
        remoteRuntimeUnavailableError(
          'Remote Orca runtime did not answer in time; resetting the control connection.'
        )
      )
    }, args.timeoutMs)
    args.pendingRequests.set(requestId, {
      method: args.method,
      resolve: resolve as (response: RuntimeRpcResponse<unknown>) => void,
      reject,
      timeout,
      refreshTimeoutOnKeepalive: args.refreshTimeoutOnKeepalive ?? false
    })
    void args.ensureReady().then(
      () => args.send(requestId, args.method, args.params),
      (error) =>
        rejectSharedControlPendingRequest(
          args.pendingRequests,
          requestId,
          toRemoteRuntimeClientError(error)
        )
    )
  })
}
