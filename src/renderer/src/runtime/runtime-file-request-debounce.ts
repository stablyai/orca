import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'

/** Delays a runtime file request so typing settles before the host scans. */
export function debounceRuntimeFileRequest<T>(
  delayMs: number,
  signal: AbortSignal,
  request: () => Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      window.clearTimeout(timer)
      reject(createRuntimeRpcAbortError())
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      void request().then(resolve, reject)
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}
