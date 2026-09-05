import { scheduleSharedControlReconnect } from './remote-runtime-shared-control-state'

const ACTIVE_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000]
const IDLE_RECONNECT_DELAYS_MS = [...ACTIVE_RECONNECT_DELAYS_MS, 60_000, 120_000, 300_000]

export class SharedControlReconnectScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private pendingOpen: (() => void) | null = null

  get isScheduled(): boolean {
    return this.timer !== null
  }

  get attemptCount(): number {
    return this.attempt
  }

  schedule(args: {
    intentionallyClosed: boolean
    delaysMs: readonly number[]
    open: () => void
  }): void {
    if (this.timer || args.intentionallyClosed) {
      return
    }
    // Why: a passive subscription owns recovery until its caller closes it; roaming outages are unbounded.
    this.pendingOpen = args.open
    const scheduled = scheduleSharedControlReconnect({
      ...args,
      current: this.timer,
      reconnectAttempt: this.attempt,
      open: () => {
        this.timer = null
        this.pendingOpen = null
        args.open()
      }
    })
    this.timer = scheduled.timer
    this.attempt = scheduled.reconnectAttempt
  }

  scheduleWithDefaultBackoff(intentionallyClosed: boolean, open: () => void): void {
    this.schedule({
      intentionallyClosed,
      delaysMs: ACTIVE_RECONNECT_DELAYS_MS,
      open
    })
  }

  scheduleWithIdleBackoff(intentionallyClosed: boolean, open: () => void): void {
    this.schedule({ intentionallyClosed, delaysMs: IDLE_RECONNECT_DELAYS_MS, open })
  }

  scheduleAfterSocketClose(args: {
    intentionallyClosed: boolean
    manuallyDisconnected: boolean
    capabilityPaused: boolean
    subscriptionCount: number
    open: () => void
  }): void {
    if (
      args.intentionallyClosed ||
      args.manuallyDisconnected ||
      (args.subscriptionCount === 0 && args.capabilityPaused)
    ) {
      return
    }
    if (args.subscriptionCount > 0) {
      this.scheduleWithDefaultBackoff(args.intentionallyClosed, args.open)
      return
    }
    this.scheduleWithIdleBackoff(args.intentionallyClosed, args.open)
  }

  // Why: OS resume / browser online should advance an already-scheduled reconnect, not start a new one.
  retryNow(): boolean {
    if (!this.timer || !this.pendingOpen) {
      return false
    }
    clearTimeout(this.timer)
    this.timer = null
    const open = this.pendingOpen
    this.pendingOpen = null
    open()
    return true
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pendingOpen = null
  }

  resetAttempt(): void {
    this.attempt = 0
  }
}
