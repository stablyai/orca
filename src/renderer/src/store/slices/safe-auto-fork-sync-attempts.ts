export const SAFE_AUTO_FORK_SYNC_COOLDOWN_MS = 10 * 60 * 1000
export const SAFE_AUTO_FORK_SYNC_MAX_ATTEMPTS = 512

type SafeAutoForkSyncAttempt = {
  attemptedAt: number
  promise: Promise<void> | null
}

export class SafeAutoForkSyncAttempts {
  private readonly attempts = new Map<string, SafeAutoForkSyncAttempt>()

  constructor(
    private readonly cooldownMs = SAFE_AUTO_FORK_SYNC_COOLDOWN_MS,
    private readonly maxAttempts = SAFE_AUTO_FORK_SYNC_MAX_ATTEMPTS
  ) {
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) {
      throw new RangeError('Safe auto-fork sync cooldown must be a non-negative integer')
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError('Safe auto-fork sync attempt cap must be a positive integer')
    }
  }

  run(key: string, attemptedAt: number, start: () => Promise<void>): boolean {
    this.pruneExpired(attemptedAt)
    const existing = this.attempts.get(key)
    if (existing?.promise || (existing && attemptedAt - existing.attemptedAt < this.cooldownMs)) {
      return false
    }
    if (!this.reserveSlot()) {
      return false
    }
    const promise = start()
    this.attempts.set(key, { attemptedAt, promise })
    const settle = (): void => {
      const current = this.attempts.get(key)
      if (current?.promise === promise) {
        this.attempts.set(key, { attemptedAt, promise: null })
      }
    }
    void promise.then(settle, settle)
    return true
  }

  evidence(): { entries: number; inFlight: number } {
    let inFlight = 0
    for (const attempt of this.attempts.values()) {
      if (attempt.promise) {
        inFlight += 1
      }
    }
    return { entries: this.attempts.size, inFlight }
  }

  private pruneExpired(now: number): void {
    for (const [key, attempt] of this.attempts) {
      if (!attempt.promise && now - attempt.attemptedAt >= this.cooldownMs) {
        this.attempts.delete(key)
      }
    }
  }

  private reserveSlot(): boolean {
    if (this.attempts.size < this.maxAttempts) {
      return true
    }
    let oldestCompleted: { key: string; attemptedAt: number } | null = null
    for (const [key, attempt] of this.attempts) {
      if (
        !attempt.promise &&
        (!oldestCompleted || attempt.attemptedAt < oldestCompleted.attemptedAt)
      ) {
        oldestCompleted = { key, attemptedAt: attempt.attemptedAt }
      }
    }
    if (!oldestCompleted) {
      return false
    }
    this.attempts.delete(oldestCompleted.key)
    return true
  }
}
