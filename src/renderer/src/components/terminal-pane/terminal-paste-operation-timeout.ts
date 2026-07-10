export type TerminalPasteOperationTimeoutResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true }

export async function runTerminalPasteOperationWithTimeout<T>(
  operation: () => T | Promise<T>,
  timeoutMs: number
): Promise<TerminalPasteOperationTimeoutResult<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { timedOut: false, value: await operation() }
  }

  let timerId: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then((value) => ({ timedOut: false as const, value })),
      new Promise<TerminalPasteOperationTimeoutResult<T>>((resolve) => {
        timerId = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      })
    ])
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId)
    }
  }
}
