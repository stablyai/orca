export type TerminalPasteOperationTimeoutResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true }

/** `signal` aborts at the timeout, so a write still held for an outage is withdrawn, not sent late. */
export async function runTerminalPasteOperationWithTimeout<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number
): Promise<TerminalPasteOperationTimeoutResult<T>> {
  const controller = new AbortController()
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { timedOut: false, value: await operation(controller.signal) }
  }

  let timerId: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then((value) => ({ timedOut: false as const, value })),
      new Promise<TerminalPasteOperationTimeoutResult<T>>((resolve) => {
        timerId = setTimeout(() => {
          controller.abort()
          resolve({ timedOut: true })
        }, timeoutMs)
      })
    ])
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId)
    }
  }
}
