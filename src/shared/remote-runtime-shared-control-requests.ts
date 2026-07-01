import { randomUUID } from 'node:crypto'
import { remoteRuntimeTimeoutError } from './remote-runtime-request-frames'
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
    }, args.timeoutMs)
    args.pendingRequests.set(requestId, {
      method: args.method,
      resolve: resolve as (response: RuntimeRpcResponse<unknown>) => void,
      reject,
      timeout
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
