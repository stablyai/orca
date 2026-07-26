const RECOVERY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const
export const REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS = 60_000

export type RemoteRuntimePtyRecoveryPhase =
  | 'idle'
  | 'recovering'
  | 'backoff'
  | 'disconnected'
  | 'disposed'

export class RemoteRuntimePtyRecoveryState {
  private phase: RemoteRuntimePtyRecoveryPhase = 'idle'
  private epoch = 0
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly onChange?: () => void) {}

  get isActive(): boolean {
    return this.phase === 'recovering' || this.phase === 'backoff'
  }

  get currentPhase(): RemoteRuntimePtyRecoveryPhase {
    return this.phase
  }

  get currentEpoch(): number {
    return this.epoch
  }

  get attemptCount(): number {
    return this.attempt
  }

  begin(): number {
    if (this.phase === 'disposed') {
      return this.epoch
    }
    if (!this.isActive) {
      this.epoch += 1
      this.attempt = 0
      this.armDeadline(this.epoch)
    }
    this.clearRetryTimer()
    this.phase = 'recovering'
    this.onChange?.()
    return this.epoch
  }

  isCurrent(epoch: number): boolean {
    return this.isActive && epoch === this.epoch
  }

  ownsEpoch(epoch: number): boolean {
    return this.phase !== 'disposed' && epoch === this.epoch
  }

  schedule(epoch: number, retry: (epoch: number) => void): boolean {
    if (!this.isCurrent(epoch)) {
      return false
    }
    this.clearRetryTimer()
    this.phase = 'backoff'
    const delayMs = RECOVERY_DELAYS_MS[Math.min(this.attempt, RECOVERY_DELAYS_MS.length - 1)]
    this.attempt += 1
    this.onChange?.()
    const timer = setTimeout(() => {
      if (this.retryTimer !== timer || !this.isCurrent(epoch)) {
        return
      }
      this.retryTimer = null
      this.phase = 'recovering'
      this.onChange?.()
      retry(epoch)
    }, delayMs)
    timer.unref?.()
    this.retryTimer = timer
    return true
  }

  markHealthy(): void {
    if (this.phase === 'disposed') {
      return
    }
    this.clearTimers()
    this.phase = 'idle'
    this.attempt = 0
    this.onChange?.()
  }

  markDisconnected(): void {
    if (this.phase === 'disposed') {
      return
    }
    this.clearTimers()
    this.phase = 'disconnected'
    this.onChange?.()
  }

  cancel(): void {
    if (this.phase === 'disposed') {
      return
    }
    this.epoch += 1
    this.clearTimers()
    this.phase = 'idle'
    this.attempt = 0
    this.onChange?.()
  }

  dispose(): void {
    this.epoch += 1
    this.clearTimers()
    this.phase = 'disposed'
    this.onChange?.()
  }

  private armDeadline(epoch: number): void {
    this.clearDeadlineTimer()
    const timer = setTimeout(() => {
      if (this.deadlineTimer !== timer || !this.isCurrent(epoch)) {
        return
      }
      this.deadlineTimer = null
      this.clearRetryTimer()
      this.phase = 'disconnected'
      this.onChange?.()
    }, REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
    timer.unref?.()
    this.deadlineTimer = timer
  }

  private clearTimers(): void {
    this.clearRetryTimer()
    this.clearDeadlineTimer()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer)
      this.deadlineTimer = null
    }
  }
}
