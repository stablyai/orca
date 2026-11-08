import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

export function createRuntimeRpcAbortError(): Error {
  const error = new Error('Runtime request aborted')
  error.name = 'AbortError'
  return error
}

export function callAbortableRuntime(args: {
  method: string
  timeoutMs?: number
  signal: AbortSignal
  subscribe: (callbacks: {
    onResponse: (response: RuntimeRpcResponse<unknown>) => void
    onError: (error: { message: string }) => void
    onClose: () => void
  }) => Promise<{ unsubscribe: () => void }>
  cancelPending?: () => void
}): Promise<RuntimeRpcResponse<unknown>> {
  if (args.signal.aborted) {
    return Promise.reject(createRuntimeRpcAbortError())
  }
  return new Promise((resolve, reject) => {
    let handle: { unsubscribe: () => void } | null = null
    let settled = false
    const deadline =
      args.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            finish(() =>
              reject(new Error(`Runtime request timed out before ${args.method} completed`))
            )
          }, args.timeoutMs)
    const finish = (complete: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline !== null) {
        clearTimeout(deadline)
      }
      args.signal.removeEventListener('abort', onAbort)
      handle?.unsubscribe()
      if (!handle) {
        args.cancelPending?.()
      }
      complete()
    }
    const onAbort = (): void => finish(() => reject(createRuntimeRpcAbortError()))
    args.signal.addEventListener('abort', onAbort, { once: true })
    void args
      .subscribe({
        onResponse: (response) => finish(() => resolve(response)),
        onError: (error) => finish(() => reject(new Error(error.message))),
        onClose: () =>
          finish(() => reject(new Error(`Runtime request closed before ${args.method} completed`)))
      })
      .then((subscription) => {
        handle = subscription
        if (settled) {
          subscription.unsubscribe()
        }
      })
      .catch((error) => finish(() => reject(error)))
  })
}
