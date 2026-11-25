/** Deadlines run on the monotonic clock: a wall-clock step must neither extend nor cut a caller's budget. */
export function monotonicNow(): number {
  return performance.now()
}

export const DEADLINE_PASSED = Symbol('deadline')

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** One reaction on the shared promise; each caller subscribes with its own deadline and unsubscribes when it lapses. */
export function createSettleNotifier<T>(
  promise: Promise<T>
): (deadline: number) => Promise<Settled<T> | typeof DEADLINE_PASSED> {
  const waiters = new Set<(settled: Settled<T>) => void>()
  let result: Settled<T> | undefined
  const settle = (settled: Settled<T>): void => {
    result = settled
    for (const waiter of waiters) {
      waiter(settled)
    }
    waiters.clear()
  }
  promise.then(
    (value) => settle({ ok: true, value }),
    (error: unknown) => settle({ ok: false, error })
  )
  return (deadline) =>
    result
      ? Promise.resolve(result)
      : new Promise((resolve) => {
          const waiter = (settled: Settled<T>): void => {
            clearTimeout(timer)
            resolve(settled)
          }
          waiters.add(waiter)
          const timer = setTimeout(
            () => {
              waiters.delete(waiter)
              resolve(DEADLINE_PASSED)
            },
            Math.max(0, deadline - monotonicNow())
          )
        })
}

export async function beforeDeadline<T>(
  pending: Promise<T>,
  deadline: number
): Promise<T | typeof DEADLINE_PASSED> {
  const settled = await createSettleNotifier(pending)(deadline)
  if (settled === DEADLINE_PASSED) {
    return DEADLINE_PASSED
  }
  if (!settled.ok) {
    throw settled.error
  }
  return settled.value
}
