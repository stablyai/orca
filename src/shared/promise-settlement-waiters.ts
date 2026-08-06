type PromiseSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }

type PromiseSettlementWaiter<T> = {
  resolve: (value: T) => void
  reject: (error: unknown) => void
  onFulfilled?: (value: T) => void
  signal?: AbortSignal
  onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
}

export type PromiseSettlementWaitOptions<T> = {
  signal?: AbortSignal
  timeoutMs?: number
  createAbortError?: () => Error
  createTimeoutError?: () => Error
  onFulfilled?: (value: T) => void
  onAbandon?: (reason: 'abort' | 'timeout') => void
}

// Why: Promise.then reactions cannot be detached. One reaction fans settlement
// into explicit waiters so aborted or timed-out callers release their closures.
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
    if (this.settlement) {
      return settleWaiterImmediately(this.settlement, options.onFulfilled)
    }
    return new Promise<T>((resolve, reject) => {
      let waiter!: PromiseSettlementWaiter<T>
      const abandon = (reason: 'abort' | 'timeout', error: Error): void => {
        if (!this.waiters.delete(waiter)) {
          return
        }
        cleanupWaiter(waiter)
        options.onAbandon?.(reason)
        reject(error)
      }
      const onAbort = (): void =>
        abandon('abort', options.createAbortError?.() ?? createDefaultAbortError())
      waiter = {
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
    })
  }

  private settle(settlement: PromiseSettlement<T>, onSettled?: () => void): void {
    if (this.settlement) {
      return
    }
    this.settlement = settlement
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter)
      cleanupWaiter(waiter)
      settleWaiter(settlement, waiter)
    }
    onSettled?.()
  }
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
