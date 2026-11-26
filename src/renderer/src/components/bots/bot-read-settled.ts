// A bot host read asked to settle: answered once, by a read that began after the ask, or uncertain.

/** How long a settled read waits from its ask, whatever runs before it, before it answers uncertain. */
export const BOT_READ_SETTLE_MS = 15_000

/** A read that started after the ask and finished in time: its value, or uncertain. */
export type BotReadSettled<T> = { ok: true; value: T } | { ok: false }

export type BotSettledWaiter<T> = {
  /** Only a read with this sequence or later started after the ask. */
  minSequence: number
  /** `performance.now()` past which any answer is uncertain. */
  deadline: number
  /** An authority fence checked when a queued read is ready to start. */
  canStart?: () => boolean
  timer: ReturnType<typeof setTimeout> | null
  resolve: (settled: BotReadSettled<T>) => void
}

/** Every terminal path ends a waiter here, once: removed from its entry, its timer cleared, then told. */
export function finishBotSettledWaiter<T>(
  waiters: Set<BotSettledWaiter<T>>,
  waiter: BotSettledWaiter<T>,
  settled: BotReadSettled<T>
): void {
  if (!waiters.delete(waiter)) {
    return
  }
  if (waiter.timer) {
    clearTimeout(waiter.timer)
  }
  waiter.resolve(settled)
}

/** Drop expired or stale asks before their shared read starts. */
export function qualifyBotSettledWaiters<T>(waiters: Set<BotSettledWaiter<T>>): boolean {
  if (waiters.size === 0) {
    return false
  }
  const at = performance.now()
  for (const waiter of waiters) {
    if (at >= waiter.deadline || waiter.canStart?.() === false) {
      finishBotSettledWaiter(waiters, waiter, { ok: false })
    }
  }
  return waiters.size > 0
}
