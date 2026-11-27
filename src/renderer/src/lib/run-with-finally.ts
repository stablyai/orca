/** Runs `work` and always runs `onFinally`, keeping `try`/`finally` out of React Compiler functions. */
export function runSyncWithFinally<T>(work: () => T, onFinally: () => void): T {
  try {
    return work()
  } finally {
    onFinally()
  }
}

/** Runs async `work` and always runs `onFinally`, keeping `try`/`finally` out of React Compiler functions. */
export async function runWithFinally<T>(
  work: () => Promise<T>,
  onFinally: () => void | Promise<void>
): Promise<T> {
  try {
    return await work()
  } finally {
    await onFinally()
  }
}
