import { scheduleSharedControlReconnect } from './remote-runtime-shared-control-state'

export class SharedControlReconnectScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0

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
    // Why: a passive subscription owns recovery until its caller closes it; roaming outages are unbounded.
    const scheduled = scheduleSharedControlReconnect({
      ...args,
      current: this.timer,
      reconnectAttempt: this.attempt,
      open: () => {
        this.timer = null
        args.open()
      }
    })
    this.timer = scheduled.timer
    this.attempt = scheduled.reconnectAttempt
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  clearWhenIdle(isIdle: boolean): void {
    if (isIdle) {
      this.clear()
    }
  }

  resetAttempt(): void {
    this.attempt = 0
  }
}
