import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'

/**
 * Bounds a local runtime RPC with the caller's deadline and abort signal.
 * Local calls are one-shot IPC requests with no cancellation channel, so this stops the caller
 * waiting but cannot cancel the work already running on the host.
 */
export function withRuntimeRpcDeadline<T>(
  call: Promise<T>,
  options: { method: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  const { method, timeoutMs, signal } = options
  if (timeoutMs === undefined && !signal) {
    return call
  }
  // The caller stops waiting on timeout or abort; keep a late rejection from becoming unhandled.
  void call.catch(() => undefined)
  if (signal?.aborted) {
    return Promise.reject(createRuntimeRpcAbortError())
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => finish(() => reject(createRuntimeRpcAbortError()))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        finish(() => reject(new Error(`Runtime request timed out before ${method} completed`)))
      }, timeoutMs)
    }
    call.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}
