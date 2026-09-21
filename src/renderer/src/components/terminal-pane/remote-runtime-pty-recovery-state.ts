export const REMOTE_RUNTIME_RECOVERY_DELAYS_MS = [
  250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000
] as const

// Why: mirrors DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS in the main-process runtime router; a silently
// dropped link burns the whole RPC timeout on the attempt each backoff step leads into.
export const REMOTE_RUNTIME_RECOVERY_ATTEMPT_BUDGET_MS = 15_000

// Why derived, not hand-tuned: a literal deadline drifted below the ladder it arms, making the last
// backoff steps unreachable dead code (#11305). Loss of contact is never evidence of exit, so the
// window must outlast the schedule it advertises rather than the schedule being trimmed to fit.
export const REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS =
  REMOTE_RUNTIME_RECOVERY_DELAYS_MS.reduce((total, delayMs) => total + delayMs, 0) +
  REMOTE_RUNTIME_RECOVERY_DELAYS_MS.length * REMOTE_RUNTIME_RECOVERY_ATTEMPT_BUDGET_MS

export type RemoteRuntimePtyRecoveryPhase =
  | 'idle'
  | 'recovering'
  | 'backoff'
  | 'disconnected'
  | 'disposed'

// Why: system resume / network online need to advance pending pane backoffs without a second coordinator.
const scheduledRecoveries = new Set<RemoteRuntimePtyRecoveryState>()

export function getScheduledRemoteRuntimePtyRecoveryCountForTests(): number {
  return scheduledRecoveries.size
}

export function retryAllRemoteRuntimePtyRecoveriesNow(): number {
  let advanced = 0
  // Why: a synchronous retry failure can schedule the same state again.
  for (const recovery of Array.from(scheduledRecoveries)) {
    if (recovery.retryNow()) {
      advanced += 1
    }
  }
  return advanced
}

export class RemoteRuntimePtyRecoveryState {
  private phase: RemoteRuntimePtyRecoveryPhase = 'idle'
  private epoch = 0
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRetry: ((epoch: number) => void) | null = null
  private pendingEpoch: number | null = null
  // Why: only the wall-clock deadline proves the auto-recovery window was actually spent; a UI latch
  // via markDisconnected() must not forge that evidence (#12683).
  private deadlineExpired = false

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

  get autoRecoveryDeadlineExpired(): boolean {
    return this.deadlineExpired
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
    const delayMs =
      REMOTE_RUNTIME_RECOVERY_DELAYS_MS[
        Math.min(this.attempt, REMOTE_RUNTIME_RECOVERY_DELAYS_MS.length - 1)
      ]
    this.attempt += 1
    this.pendingRetry = retry
    this.pendingEpoch = epoch
    const timer = setTimeout(() => {
      if (this.retryTimer !== timer || !this.isCurrent(epoch)) {
        return
      }
      this.retryTimer = null
      this.pendingRetry = null
      this.pendingEpoch = null
      scheduledRecoveries.delete(this)
      this.phase = 'recovering'
      this.onChange?.()
      retry(epoch)
    }, delayMs)
    timer.unref?.()
    this.retryTimer = timer
    scheduledRecoveries.add(this)
    this.onChange?.()
    return true
  }

  // Why: a wait that ends with no liveness evidence arms no timer, so park a retry or online/resume/reconnect find nothing to revive.
  parkRetryForExternalTrigger(epoch: number, retry: (epoch: number) => void): boolean {
    return this.isCurrent(epoch) && this.parkRetry(retry)
  }

  // Why: the deadline can latch while an attempt is still in flight, before schedule() parked anything,
  // so the late failure has no live epoch to join and must not begin a new one — that would re-arm a
  // full-length window and the budget would never actually expire.
  parkRetryAfterDeadline(retry: (epoch: number) => void): boolean {
    return this.phase === 'disconnected' && this.parkRetry(retry)
  }

  private parkRetry(retry: (epoch: number) => void): boolean {
    if (this.pendingRetry !== null) {
      return false
    }
    this.pendingRetry = retry
    this.pendingEpoch = this.epoch
    scheduledRecoveries.add(this)
    return true
  }

  // Why: a one-shot retry whose owner already resolved elsewhere would otherwise survive the cutoff as fake revivable work.
  discardPendingRetry(retry: (epoch: number) => void): void {
    if (this.pendingRetry !== retry) {
      return
    }
    this.clearRetryTimer()
  }

  // Why: resume/online should fire an already-scheduled backoff immediately, not start a new epoch.
  retryNow(): boolean {
    if (this.pendingRetry === null || this.pendingEpoch === null) {
      return false
    }
    if (this.phase !== 'backoff' && this.phase !== 'disconnected') {
      return false
    }
    const retry = this.pendingRetry
    const latched = this.phase === 'disconnected'
    this.clearRetryTimer()
    if (latched) {
      // Why: the deadline only stops auto-retry; an explicit trigger opens a fresh recovery window.
      this.epoch += 1
      this.attempt = 0
      this.armDeadline(this.epoch)
    }
    const epoch = this.epoch
    this.phase = 'recovering'
    this.onChange?.()
    retry(epoch)
    return true
  }

  markHealthy(): void {
    if (this.phase === 'disposed') {
      return
    }
    this.deadlineExpired = false
    this.clearTimers()
    this.phase = 'idle'
    this.attempt = 0
    this.onChange?.()
  }

  markDisconnected(): void {
    if (this.phase === 'disposed') {
      return
    }
    // Why: same latch the deadline arrives at, so it must be equally revivable — stop auto-retry but keep
    // the parked retry registered for online/resume/reconnect. clearTimers() here would be strictly more
    // destructive than exhausting the whole recovery budget.
    this.stopRetryTimer()
    this.clearDeadlineTimer()
    this.phase = 'disconnected'
    this.onChange?.()
  }

  cancel(): void {
    if (this.phase === 'disposed') {
      return
    }
    this.deadlineExpired = false
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
    this.deadlineExpired = false
    const timer = setTimeout(() => {
      if (this.deadlineTimer !== timer || !this.isCurrent(epoch)) {
        return
      }
      this.deadlineTimer = null
      this.deadlineExpired = true
      // Why: the cutoff stops self-initiated retries but must keep the pane revivable by online/resume/reconnect.
      this.stopRetryTimer()
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

  private stopRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private clearRetryTimer(): void {
    this.stopRetryTimer()
    this.pendingRetry = null
    this.pendingEpoch = null
    scheduledRecoveries.delete(this)
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer)
      this.deadlineTimer = null
    }
  }
}
