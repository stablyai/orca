import { abortSignalReason } from './abort-signal-reason'
import { isTimedPRRead, type RuntimeRpcCallQueuePool } from './runtime-rpc-call-queue'

export function enqueueRuntimeSubscription<T>(
  pool: RuntimeRpcCallQueuePool,
  selector: string,
  method: string,
  params: unknown,
  open: (complete: () => void) => Promise<T>,
  close: (handle: T) => void,
  signal?: AbortSignal,
  retainedBytes = 0
): Promise<T> {
  if (!isTimedPRRead(method, params)) {
    return pool.enqueue(selector, method, () => open(() => {}), retainedBytes, signal, params)
  }
  const setup = Promise.withResolvers<T>()
  const completion = Promise.withResolvers<void>()
  let handle: T | undefined
  let completed = false
  const closeHandle = (value: T): void => {
    try {
      close(value)
    } catch {
      // Terminal cleanup must still release admission if transport close throws.
    }
  }
  const complete = (): void => {
    if (completed) {
      return
    }
    completed = true
    completion.resolve()
    if (handle !== undefined) {
      const terminalHandle = handle
      queueMicrotask(() => closeHandle(terminalHandle))
    }
  }
  const onAbort = (): void => {
    complete()
    if (signal) {
      setup.reject(abortSignalReason(signal))
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  void pool
    .enqueue(
      selector,
      method,
      async () => {
        void Promise.resolve()
          .then(() => open(complete))
          .then(
            (opened) => {
              handle = opened
              if (completed) {
                closeHandle(opened)
              }
              setup.resolve(opened)
            },
            (error) => {
              setup.reject(error)
              complete()
            }
          )
        await completion.promise
      },
      retainedBytes,
      signal,
      params
    )
    .catch(setup.reject)
    .finally(() => {
      signal?.removeEventListener('abort', onAbort)
    })
  return setup.promise
}
