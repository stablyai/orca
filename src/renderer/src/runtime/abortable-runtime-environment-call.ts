import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  RuntimeRpcDispatchObservation,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'

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
  expectedEnvironmentPairingRevision?: number,
  expectedEnvironmentRuntimeId?: string,
  onSent?: (sentAt?: number) => void,
  dispatchObservation?: RuntimeRpcDispatchObservation
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal.aborted) {
    throw createRuntimeRpcAbortError()
  }
  // Unsubscribe closes the host request context; one-shot calls cannot cancel host work.
  return new Promise((resolve, reject) => {
    const subscriptionId = createBrowserUuid()
    let handle: { unsubscribe: () => void } | null = null
    let settled = false
    let sent = false
    // Subscription timeout bounds start only; retain the response deadline or connected unresponsive hosts stall forever.
    let deadline =
      timeoutMs === undefined
        ? null
        : setTimeout(
            () => {
              finish(() =>
                reject(new Error(`Runtime request timed out before ${method} completed`))
              )
            },
            dispatchObservation
              ? Math.max(
                  0,
                  (dispatchObservation.responseExpiresAt ??
                    dispatchObservation.expiresAt + dispatchObservation.responseTimeoutMs) -
                    Date.now()
                )
              : timeoutMs
          )
    const finish = (complete: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline !== null) {
        clearTimeout(deadline)
      }
      signal.removeEventListener('abort', onAbort)
      handle?.unsubscribe()
      if (!handle) {
        void window.api.runtimeEnvironments
          .cancelSubscription({ subscriptionId })
          .catch(() => undefined)
      }
      complete()
    }
    const onAbort = (): void => finish(() => reject(createRuntimeRpcAbortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    void window.api.runtimeEnvironments
      .subscribe(
        {
          subscriptionId,
          selector: environmentId,
          method,
          params,
          timeoutMs,
          expectedEnvironmentPairingRevision,
          expectedEnvironmentRuntimeId,
          observeDispatch: Boolean(onSent),
          dispatchObservation
        },
        {
          onSent: (sentAt) => {
            if (sent || settled) {
              return
            }
            sent = true
            try {
              onSent?.(sentAt)
            } catch (error) {
              finish(() => reject(error))
              return
            }
            if (deadline !== null) {
              clearTimeout(deadline)
            }
            if (timeoutMs !== undefined) {
              deadline = setTimeout(
                () => finish(() => reject(new Error('Request timed out'))),
                dispatchObservation
                  ? Math.max(
                      0,
                      (dispatchObservation.responseExpiresAt ??
                        (sentAt ?? Date.now()) + dispatchObservation.responseTimeoutMs) - Date.now()
                    )
                  : timeoutMs
              )
            }
          },
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
