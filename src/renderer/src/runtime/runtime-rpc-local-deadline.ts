import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'

/**
 * Bound a local (desktop IPC) runtime RPC with the caller's deadline and abort.
 *
 * Why: `ipcRenderer.invoke('runtime:call')` settles only when the main-process
 * handler returns, and that handler dispatches without a deadline of its own.
 * The environment path already honours `timeoutMs` and `signal`, so a caller
 * that asks for either must get it here too. Otherwise a stalled dispatch
 * leaves the renderer awaiting a promise that never settles, with no way back
 * to a rendered state.
 */
export function withLocalRuntimeRpcDeadline<T>(
  pending: Promise<T>,
  method: string,
  options: { timeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  const { timeoutMs, signal } = options
  if (timeoutMs === undefined && signal === undefined) {
    return pending
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
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
      signal?.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = (): void => finish(() => reject(createRuntimeRpcAbortError()))
    // Why: an already-aborted signal never fires 'abort', so the listener alone
    // would leave this promise pending for a caller that aborted before we ran.
    if (signal?.aborted) {
      finish(() => reject(createRuntimeRpcAbortError()))
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}
