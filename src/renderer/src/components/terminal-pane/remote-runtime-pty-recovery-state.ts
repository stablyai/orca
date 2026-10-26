import type { PtyConnectResult } from './pty-transport-types'

import {
  REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS,
  REMOTE_RUNTIME_RECOVERY_DELAYS_MS
} from './remote-runtime-pty-recovery-limits'
export * from './remote-runtime-pty-recovery-limits'
export * from './remote-runtime-pty-control-ready-revivers'

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
  // Caller settlement does not restore this epoch's spent owner-refresh allowance.
  private ownerRefresh: {
    promise: Promise<PtyConnectResult | undefined>
    settle: ((result?: PtyConnectResult) => void) | null
    retry: (epoch: number) => void
  } | null = null
  private phase: RemoteRuntimePtyRecoveryPhase = 'idle'
  private epoch = 0
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRetry: ((epoch: number) => void) | null = null
  private pendingEpoch: number | null = null
  // Only wall-clock expiry proves spent recovery time; a UI latch cannot authorize fenced-handle reuse (#12683).
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

  /** A retry is parked for online/resume/control-ready or a host publish; nothing is in flight. */
  get awaitingExternalTrigger(): boolean {
    return this.phase === 'recovering' && this.pendingRetry !== null && this.retryTimer === null
  }

  get hasOwnerRefresh(): boolean {
    return this.ownerRefresh !== null
  }

  claimOwnerRefresh(epoch: number, retry: (epoch: number) => void) {
    if (!this.isCurrent(epoch)) {
      return null
    }
    if (this.ownerRefresh) {
      return { started: false, promise: this.ownerRefresh.promise }
    }
    const { promise, resolve } = Promise.withResolvers<PtyConnectResult | undefined>()
    this.ownerRefresh = { promise, settle: resolve, retry }
    return { started: true, promise }
  }

  parkOwnerRefresh(epoch: number): void {
    if (!this.ownsEpoch(epoch) || !this.ownerRefresh) {
      return
    }
    this.settleOwnerRefresh()
    if (this.isActive) {
      this.parkRetryForExternalTrigger(epoch, this.ownerRefresh.retry)
    } else {
      this.parkRetryAfterDeadline(this.ownerRefresh.retry)
    }
  }

  private settleOwnerRefresh(result?: PtyConnectResult): void {
    const refresh = this.ownerRefresh
    if (refresh?.settle) {
      const settle = refresh.settle
      refresh.settle = null
      settle(result)
    }
  }

  private clearOwnerRefresh(result?: PtyConnectResult): void {
    this.settleOwnerRefresh(result)
    this.ownerRefresh = null
  }

  begin(): number {
    if (this.phase === 'disposed') {
      return this.epoch
    }
    if (!this.isActive) {
      this.clearOwnerRefresh()
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

  // Why the override: a caller pacing its own repeats (a flapping stream) outranks the per-epoch ladder.
  schedule(epoch: number, retry: (epoch: number) => void, delayOverrideMs?: number): boolean {
    if (!this.isCurrent(epoch)) {
      return false
    }
    this.clearRetryTimer()
    this.phase = 'backoff'
    const delayMs =
      delayOverrideMs ??
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
    if (!this.isCurrent(epoch) || !this.parkRetry(retry)) {
      return false
    }
    // Why: the phase stays 'recovering', but the pane must now say it waits rather than retries.
    this.onChange?.()
    return true
  }

  // Post-deadline failures park without beginning a new epoch, or silent RPC timeouts would re-arm the window forever.
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

  // Why: resume/online should fire a scheduled or parked retry immediately, not start a new epoch.
  retryNow(): boolean {
    if (this.pendingRetry === null || this.pendingEpoch === null) {
      return false
    }
    // Why: a retry pending while 'recovering' is one parked for an external trigger, with nothing in flight.
    if (this.phase === 'idle' || this.phase === 'disposed') {
      return false
    }
    const retry = this.pendingRetry
    const latched = this.phase === 'disconnected'
    this.clearRetryTimer()
    if (latched) {
      // Why: the deadline only stops auto-retry; an explicit trigger opens a fresh recovery window.
      this.clearOwnerRefresh()
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

  markHealthy(result?: PtyConnectResult): void {
    if (this.phase === 'disposed') {
      return
    }
    this.clearOwnerRefresh(result)
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
    // Fatal latching stops automatic work but preserves parked retry registration for online/resume/Reconnect, like deadline expiry.
    this.stopRetryTimer()
    this.clearDeadlineTimer()
    this.phase = 'disconnected'
    if (this.ownerRefresh) {
      this.settleOwnerRefresh()
      this.clearRetryTimer()
      this.parkRetry(this.ownerRefresh.retry)
    }
    this.onChange?.()
  }

  cancel(): void {
    if (this.phase === 'disposed') {
      return
    }
    this.clearOwnerRefresh()
    this.deadlineExpired = false
    this.epoch += 1
    this.clearTimers()
    this.phase = 'idle'
    this.attempt = 0
    this.onChange?.()
  }

  dispose(): void {
    this.clearOwnerRefresh()
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
      this.markDisconnected()
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
