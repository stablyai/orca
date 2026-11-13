import type {
  RendererStatusAck,
  RendererStatusPublication,
  RendererStatusRecord
} from '../../../../shared/agent-status/renderer-status-publication'
import { rendererStatusOccupantKey } from '../../../../shared/agent-status/renderer-status-publication'

/** One in-flight batch; mutations after capture stay queued under a later sequence. */
export class RendererStatusSender {
  private pending = new Map<string, RendererStatusRecord>()
  private last = new Map<string, RendererStatusRecord>()
  private snapshot = true
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight = false
  private active = false
  private stopped = false
  private retryDelay = 0

  constructor(
    private readonly epoch: string,
    private readonly capture: (key: string) => RendererStatusRecord | null,
    private readonly keys: () => Iterable<string>,
    private readonly send: (batch: RendererStatusPublication) => Promise<RendererStatusAck>,
    private readonly cursor = { seq: 0 }
  ) {}

  graphAccepted(): void {
    if (this.stopped) {
      return
    }
    this.active = true
    this.schedule()
  }

  changed(keys: ReadonlySet<string> | null): void {
    if (this.stopped) {
      return
    }
    if (keys === null) {
      this.snapshot = true
    } else {
      for (const key of keys) {
        this.stage(key)
      }
    }
    this.schedule()
  }

  private stage(key: string): void {
    const current = this.capture(key)
    const previous = this.last.get(key)
    if (
      previous &&
      (!current || rendererStatusOccupantKey(previous) !== rendererStatusOccupantKey(current))
    ) {
      this.pending.set(rendererStatusOccupantKey(previous), { ...previous, row: null })
    }
    if (current) {
      this.pending.set(rendererStatusOccupantKey(current), current)
      this.last.set(key, current)
    } else {
      this.last.delete(key)
    }
  }

  private schedule(): void {
    if (
      !this.active ||
      this.stopped ||
      this.inFlight ||
      this.timer ||
      (!this.snapshot && !this.pending.size)
    ) {
      return
    }
    // Hidden renderers still publish; animation frames may be suspended indefinitely.
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.flush()
      },
      Math.max(16, this.retryDelay)
    )
  }

  private async flush(): Promise<void> {
    const snapshot = this.snapshot
    this.snapshot = false
    let rows: RendererStatusRecord[]
    if (snapshot) {
      rows = []
      this.last.clear()
      for (const key of this.keys()) {
        const record = this.capture(key)
        if (record) {
          rows.push(record)
          this.last.set(key, record)
        }
      }
    } else {
      rows = [...this.pending.values()]
    }
    this.pending.clear()
    this.inFlight = true
    try {
      const ack = await this.send({
        type: snapshot ? 'snapshot' : 'changes',
        epoch: this.epoch,
        seq: ++this.cursor.seq,
        rows
      })
      if (!ack.accepted && ack.reason === 'superseded') {
        this.stop()
        return
      }
      this.retryDelay = ack.accepted ? 0 : Math.min(2000, (this.retryDelay || 50) * 2)
      if (ack.snapshotRequired || !ack.accepted) {
        this.snapshot = true
      }
    } catch {
      this.retryDelay = Math.min(2000, (this.retryDelay || 50) * 2)
      this.snapshot = true
    } finally {
      this.inFlight = false
      this.schedule()
    }
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.pending.clear()
    this.last.clear()
  }
}
