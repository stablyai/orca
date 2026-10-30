import type { ForegroundReadReason } from './pane-foreground-agent-tracker-contract'

type ReadForeground = (
  generation: number,
  retryIndex: number,
  reason: ForegroundReadReason
) => Promise<void>

export class PaneForegroundReadScheduler {
  generation = 0
  scheduledReason: ForegroundReadReason | null = null
  activeReason: ForegroundReadReason | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly read: ReadForeground) {}

  cancel(): void {
    this.generation += 1
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.scheduledReason = null
    this.activeReason = null
  }

  schedule(delay: number, retryIndex: number, reason: ForegroundReadReason): void {
    const generation = this.generation
    this.scheduledReason = reason
    this.timer = setTimeout(() => {
      this.timer = null
      const startedReason = this.scheduledReason ?? reason
      this.scheduledReason = null
      this.activeReason = startedReason
      void this.read(generation, retryIndex, startedReason).finally(() => {
        if (generation === this.generation) {
          this.activeReason = null
        }
      })
    }, delay)
  }
}
