type PromiseSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }

type PromiseSettlementWaiter<T> = {
  ready: boolean
  resolve: (value: T) => void
  reject: (error: unknown) => void
  onFulfilled?: (value: T) => void
  signal?: AbortSignal
  onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
}

export type PromiseSettlementWaitOptions<T> = {
  signal?: AbortSignal
  /** Defer delivery a microtask so an abort queued after this wait() still wins.
   *  Later callers settle in the first caller's reaction turn, not their own. */
  deferSettled?: boolean
  /** Preserve Promise.race ordering when raw settlement and abort share a turn. */
  abortInMicrotask?: boolean
  timeoutMs?: number
  createAbortError?: () => unknown
  createTimeoutError?: () => Error
  onFulfilled?: (value: T) => void
  onAbandon?: (reason: 'abort' | 'timeout') => void
}

// Promise reactions cannot detach; fan one reaction into removable waiters so timeout/abort releases caller closures.
export class PromiseSettlementWaiters<T> {
  private readonly waiters = new Set<PromiseSettlementWaiter<T>>()
  private settlement: PromiseSettlement<T> | null = null

  constructor(
    readonly promise: Promise<T>,
    onSettled?: () => void
  ) {
    void this.promise.then(
      (value) => this.settle({ status: 'fulfilled', value }, onSettled),
      (error: unknown) => this.settle({ status: 'rejected', error }, onSettled)
    )
  }

  get waiterCount(): number {
    return this.waiters.size
  }

  wait(options: PromiseSettlementWaitOptions<T> = {}): Promise<T> {
    if (options.signal?.aborted) {
      options.onAbandon?.('abort')
      return Promise.reject(options.createAbortError?.() ?? createDefaultAbortError())
    }
    if (this.settlement && !options.deferSettled) {
      return settleWaiterImmediately(this.settlement, options.onFulfilled)
    }
    return new Promise<T>((resolve, reject) => {
      let waiter!: PromiseSettlementWaiter<T>
      const abandon = (reason: 'abort' | 'timeout', error: unknown): void => {
        if (!this.waiters.delete(waiter)) {
          return
        }
        cleanupWaiter(waiter)
        options.onAbandon?.(reason)
        reject(error)
      }
      const onAbort = (): void => {
        const error = options.createAbortError?.() ?? createDefaultAbortError()
        if (options.abortInMicrotask) {
          queueMicrotask(() => abandon('abort', error))
        } else {
          abandon('abort', error)
        }
      }
      waiter = {
        ready: !options.deferSettled,
        resolve,
        reject,
        onFulfilled: options.onFulfilled,
        signal: options.signal,
        onAbort
      }
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(
          () =>
            abandon(
              'timeout',
              options.createTimeoutError?.() ?? new Error('Promise settlement wait timed out')
            ),
          Math.max(1, options.timeoutMs)
        )
        waiter.timer.unref?.()
      }
      this.waiters.add(waiter)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) {
        onAbort()
      }
      if (options.deferSettled) {
        queueMicrotask(() => {
          waiter.ready = true
          const settlement = this.settlement
          if (settlement && this.waiters.delete(waiter)) {
            cleanupWaiter(waiter)
            settleWaiter(settlement, waiter)
          }
        })
      }
    })
  }

  private settle(settlement: PromiseSettlement<T>, onSettled?: () => void): void {
    if (this.settlement) {
      return
    }
    this.settlement = settlement
    for (const waiter of this.waiters) {
      if (!waiter.ready) {
        continue
      }
      this.waiters.delete(waiter)
      cleanupWaiter(waiter)
      settleWaiter(settlement, waiter)
    }
    onSettled?.()
  }
}

const sharedWaiters = new WeakMap<Promise<unknown>, PromiseSettlementWaiters<unknown>>()

/** One settlement observer per shared operation; abandoned callers can detach independently. */
export function sharedPromiseSettlementWaiters<T>(
  promise: Promise<T>
): PromiseSettlementWaiters<T> {
  let waiters = sharedWaiters.get(promise)
  if (!waiters) {
    waiters = new PromiseSettlementWaiters<unknown>(promise)
    sharedWaiters.set(promise, waiters)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the promise key supplies this observer's only settlement, whose value is T.
  return waiters as PromiseSettlementWaiters<T>
}

function cleanupWaiter<T>(waiter: PromiseSettlementWaiter<T>): void {
  if (waiter.timer) {
    clearTimeout(waiter.timer)
  }
  waiter.signal?.removeEventListener('abort', waiter.onAbort)
}

function settleWaiter<T>(
  settlement: PromiseSettlement<T>,
  waiter: Pick<PromiseSettlementWaiter<T>, 'resolve' | 'reject' | 'onFulfilled'>
): void {
  if (settlement.status === 'rejected') {
    waiter.reject(settlement.error)
    return
  }
  try {
    waiter.onFulfilled?.(settlement.value)
    waiter.resolve(settlement.value)
  } catch (error) {
    waiter.reject(error)
  }
}

function settleWaiterImmediately<T>(
  settlement: PromiseSettlement<T>,
  onFulfilled?: (value: T) => void
): Promise<T> {
  return new Promise((resolve, reject) =>
    settleWaiter(settlement, { resolve, reject, onFulfilled })
  )
}

function createDefaultAbortError(): Error {
  const error = new Error('Promise settlement wait aborted')
  error.name = 'AbortError'
  return error
}
