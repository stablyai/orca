export function abortSignalReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

export function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalReason(signal)
  }
}

export function waitForPromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    return Promise.reject(abortSignalReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortSignalReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
