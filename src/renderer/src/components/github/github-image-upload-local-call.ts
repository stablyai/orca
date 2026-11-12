import { abortSignalReason } from '../../../../shared/abort-signal-reason'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'

export async function callAbortableGitHubImageUpload<T>(
  method: string,
  params: unknown,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted()
  const response = await new Promise<RuntimeRpcResponse<unknown>>((resolve, reject) => {
    let handle: { unsubscribe: () => void } | null = null
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      handle?.unsubscribe()
      complete()
    }
    const onAbort = () => finish(() => reject(abortSignalReason(signal)))
    signal.addEventListener('abort', onAbort, { once: true })
    void window.api.runtime
      .subscribe({ method, params }, (value) => {
        finish(() => resolve(value))
      })
      .then((subscription) => {
        handle = subscription
        if (settled) {
          subscription.unsubscribe()
        }
      })
      .catch((error) => finish(() => reject(error)))
  })
  return unwrapRuntimeRpcResult<T>(response as RuntimeRpcResponse<T>)
}
