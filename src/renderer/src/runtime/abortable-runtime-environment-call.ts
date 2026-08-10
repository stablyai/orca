import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { createBrowserUuid } from '../lib/browser-uuid'

export function createRuntimeRpcAbortError(): Error {
  const error = new Error('Runtime request aborted')
  error.name = 'AbortError'
  return error
}

export async function callAbortableRuntimeEnvironment(
  environmentId: string,
  method: string,
  params: unknown,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  expectedEnvironmentPairingRevision?: number
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal.aborted) {
    throw createRuntimeRpcAbortError()
  }
  const subscriptionId = createBrowserUuid()
  // Why: the one-shot runtime call bridge cannot cancel host work; the
  // subscription bridge closes its request context when we unsubscribe.
  return new Promise((resolve, reject) => {
    let handle: { unsubscribe: () => void } | null = null
    let settled = false
    // Why: the subscription transport's own timeout only bounds subscription
    // start, not the response. Keep the one-shot call path's response deadline
    // so a connected-but-unresponsive runtime cannot stall the caller forever.
    const deadline =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            finish(() => reject(new Error(`Runtime request timed out before ${method} completed`)))
          }, timeoutMs)
    const finish = (complete: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline !== null) {
        clearTimeout(deadline)
      }
      signal.removeEventListener('abort', onAbort)
      if (handle) {
        handle.unsubscribe()
      } else {
        // Why: setup can still be opening a dedicated remote socket, before a
        // handle exists; cancel by id so superseded calls do not fan out sockets.
        void window.api.runtimeEnvironments.cancelSubscription?.({ subscriptionId }).catch(() => {})
      }
      complete()
    }
    const onAbort = (): void => finish(() => reject(createRuntimeRpcAbortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    void window.api.runtimeEnvironments
      .subscribe(
        {
          selector: environmentId,
          method,
          params,
          timeoutMs,
          expectedEnvironmentPairingRevision,
          subscriptionId
        },
        {
          onResponse: (response) => finish(() => resolve(response)),
          onError: (error) => finish(() => reject(new Error(error.message))),
          onClose: () =>
            finish(() => reject(new Error(`Runtime request closed before ${method} completed`)))
        }
      )
      .then((subscription) => {
        handle = subscription
        if (settled) {
          subscription.unsubscribe()
        }
      })
      .catch((error) => finish(() => reject(error)))
  })
}
