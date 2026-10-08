export const REMOTE_TERMINAL_INPUT_RECEIPT_TIMEOUT_MS = 15_000
export const REMOTE_TERMINAL_INPUT_RECEIPT_LIMIT = 1_024

/** Tracks receipts, never input text: uncertain writes must not be replayed. */
export class RemoteTerminalInputReceipts {
  private readonly pending = new Map<number, number>()
  private nextSequence = 1
  private timer: ReturnType<typeof setTimeout> | null = null
  private warned = false

  constructor(private readonly onUnverifiable: () => void) {}

  begin(): number {
    if (this.pending.size >= REMOTE_TERMINAL_INPUT_RECEIPT_LIMIT) {
      this.reportUnverifiable()
      this.clear()
    }
    const sequence = this.nextSequence++
    this.pending.set(sequence, Date.now())
    this.scheduleDeadline()
    return sequence
  }

  settle(sequence: number, outcome: 'accepted' | 'refused' | 'unverifiable'): void {
    if (!this.pending.delete(sequence)) {
      return
    }
    if (outcome === 'unverifiable') {
      this.reportUnverifiable()
    }
    this.cancelDeadline()
    this.scheduleDeadline()
  }

  dispose(): void {
    if (this.pending.size > 0) {
      this.reportUnverifiable()
    }
    this.clear()
  }

  private reportUnverifiable(): void {
    if (!this.warned) {
      this.warned = true
      this.onUnverifiable()
    }
  }

  private scheduleDeadline(): void {
    const oldest = this.pending.values().next().value
    if (this.timer !== null || oldest === undefined) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.reportUnverifiable()
        this.clear()
      },
      Math.max(0, oldest + REMOTE_TERMINAL_INPUT_RECEIPT_TIMEOUT_MS - Date.now())
    )
  }

  private cancelDeadline(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private clear(): void {
    this.cancelDeadline()
    this.pending.clear()
  }
}
