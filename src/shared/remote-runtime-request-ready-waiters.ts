export type RemoteRuntimeRequestReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

export function waitForRemoteRuntimeRequestReady(
  waiters: RemoteRuntimeRequestReadyWaiter[]
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    waiters.push({ resolve, reject })
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
