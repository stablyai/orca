import { abortSignalReason } from './abort-signal-reason'

export type RemoteRuntimeRequestReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

export function waitForRemoteRuntimeRequestReady(
  waiters: RemoteRuntimeRequestReadyWaiter[],
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortSignalReason(signal))
  }
  return new Promise<void>((resolve, reject) => {
    let waiter!: RemoteRuntimeRequestReadyWaiter
    const remove = (): void => {
      const index = waiters.indexOf(waiter)
      if (index !== -1) {
        waiters.splice(index, 1)
      }
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      remove()
      reject(abortSignalReason(signal!))
    }
    waiter = {
      resolve: () => {
        remove()
        resolve()
      },
      reject: (error) => {
        remove()
        reject(error)
      }
    }
    waiters.push(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

export function resolveRemoteRuntimeRequestReadyWaiters(
  waiters: RemoteRuntimeRequestReadyWaiter[]
): void {
  for (const waiter of waiters.splice(0)) {
    waiter.resolve()
  }
}

export function rejectRemoteRuntimeRequestReadyWaiters(
  waiters: RemoteRuntimeRequestReadyWaiter[],
  error: Error
): void {
  for (const waiter of waiters.splice(0)) {
    waiter.reject(error)
  }
}
