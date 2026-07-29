/** Waits for a timer, rejecting if the optional cancellation signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => finish(createAbortError())
    const timer = setTimeout(() => finish(), ms)

    function finish(error?: Error): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createAbortError(): Error {
  const error = new Error('Sleep aborted')
  error.name = 'AbortError'
  return error
}
