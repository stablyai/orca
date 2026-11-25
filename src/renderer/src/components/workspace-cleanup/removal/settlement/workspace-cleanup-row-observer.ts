/** Row observers only drive progress UI; their errors must never read as removal failures. */
export function notifyWorkspaceCleanupRowObserver<T>(
  observer: ((row: T) => void) | undefined,
  row: T
): void {
  try {
    observer?.(row)
  } catch (callbackError) {
    console.error('Workspace cleanup row callback failed', callbackError)
  }
}
