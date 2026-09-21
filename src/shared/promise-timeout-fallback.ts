/**
 * Resolve `fallback` when `promise` has not settled within `timeoutMs`.
 *
 * Note that a rejection also resolves the fallback, so a caller that needs to tell "timed out" apart
 * from "failed" must absorb the rejection itself before handing the promise over.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  return new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback), timeoutMs)
    promise.then(
      (value) => resolve(value),
      () => resolve(fallback)
    )
  }).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
}
