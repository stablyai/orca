const FALLBACK_INTERVAL_MS = 16
const TARGET_CHARS_PER_FRAME = 24
const MAX_DRAIN_FRAMES = 8
export const BUFFERED_FINAL_CHARS_PER_SECOND = 120

export type StreamingTextFrameTarget = {
  scopeId: string
  messageId: string
  blockIndex: number
}

type BufferedDelta = StreamingTextFrameTarget & {
  text: string
  charsPerSecond?: number
  credit: number
  lastFrameAt: number | null
}

type EnqueueOptions = { charsPerSecond?: number }

export class StreamingTextFrameQueue {
  private readonly buffers = new Map<string, BufferedDelta>()
  private readonly visibleTargets = new Set<string>()
  private readonly liveTargets = new Set<string>()
  private frame: number | null = null
  private scheduler: 'animation-frame' | 'timeout' | null = null
  private drainCallbacks: (() => void)[] = []
  private drainFramesRemaining: number | null = null
  private draining = false

  constructor(private readonly onFlush: (deltas: BufferedDelta[]) => void) {}

  enqueue(target: StreamingTextFrameTarget, text: string, options?: EnqueueOptions): void {
    if (!text) {
      return
    }
    const key = targetKey(target)
    if (this.visibleTargets.has(key)) {
      this.liveTargets.add(key)
    }
    const current = this.buffers.get(key)
    this.buffers.set(key, {
      ...target,
      text: `${current?.text ?? ''}${text}`,
      charsPerSecond: current?.charsPerSecond ?? options?.charsPerSecond,
      credit: current?.credit ?? 0,
      lastFrameAt: current?.lastFrameAt ?? null
    })
    this.schedule()
  }

  discard(target: StreamingTextFrameTarget): void {
    const key = targetKey(target)
    this.buffers.delete(key)
    this.visibleTargets.delete(key)
    this.liveTargets.delete(key)
    if (this.buffers.size === 0) {
      this.finishDrain()
    }
  }

  drainBefore(callback: () => void): boolean {
    if (
      this.buffers.size === 0 ||
      !this.canUseAnimationFrame() ||
      (!this.hasRateLimitedBuffers() && this.bufferedLength() <= TARGET_CHARS_PER_FRAME)
    ) {
      this.flushNow()
      return false
    }
    this.drainCallbacks.push(callback)
    if (!this.draining) {
      this.draining = true
      if (
        !this.hasRateLimitedBuffers() &&
        [...this.buffers.keys()].every((key) => this.liveTargets.has(key))
      ) {
        this.drainFramesRemaining = MAX_DRAIN_FRAMES
      }
    }
    this.schedule()
    return true
  }

  reset(): void {
    this.cancelScheduled()
    this.buffers.clear()
    this.visibleTargets.clear()
    this.liveTargets.clear()
    this.drainCallbacks = []
    this.drainFramesRemaining = null
    this.draining = false
  }

  private flushNow(): void {
    this.cancelScheduled()
    if (this.buffers.size > 0) {
      const deltas = [...this.buffers.values()]
      this.buffers.clear()
      this.onFlush(deltas)
    }
    this.finishDrain()
  }

  private flushFrame(timestamp: number): void {
    if (this.buffers.size === 0) {
      this.finishDrain()
      return
    }
    const deltas: BufferedDelta[] = []
    for (const [key, buffered] of this.buffers) {
      let length: number
      let credit = buffered.credit
      if (buffered.charsPerSecond) {
        const elapsed =
          buffered.lastFrameAt === null
            ? FALLBACK_INTERVAL_MS
            : Math.max(0, timestamp - buffered.lastFrameAt)
        credit += (elapsed * buffered.charsPerSecond) / 1_000
        length = Math.floor(credit)
        credit -= length
      } else {
        length =
          this.drainFramesRemaining === null
            ? TARGET_CHARS_PER_FRAME
            : Math.max(
                TARGET_CHARS_PER_FRAME,
                Math.ceil(buffered.text.length / this.drainFramesRemaining)
              )
      }
      if (length === 0) {
        this.buffers.set(key, { ...buffered, credit, lastFrameAt: timestamp })
        continue
      }
      const text = buffered.text.slice(0, length)
      const remaining = buffered.text.slice(text.length)
      deltas.push({ ...buffered, text, credit, lastFrameAt: timestamp })
      this.visibleTargets.add(key)
      if (remaining) {
        this.buffers.set(key, {
          ...buffered,
          text: remaining,
          credit,
          lastFrameAt: timestamp
        })
      } else {
        this.buffers.delete(key)
      }
    }
    if (deltas.length > 0) {
      this.onFlush(deltas)
    }
    if (this.drainFramesRemaining !== null) {
      this.drainFramesRemaining -= 1
    }
    if (this.buffers.size > 0) {
      this.schedule()
    } else {
      this.finishDrain()
    }
  }

  private finishDrain(): void {
    this.drainFramesRemaining = null
    this.draining = false
    const callbacks = this.drainCallbacks.splice(0)
    for (const callback of callbacks) {
      callback()
    }
  }

  private schedule(): void {
    if (this.frame !== null) {
      return
    }
    if (this.canUseAnimationFrame()) {
      this.scheduler = 'animation-frame'
      this.frame = window.requestAnimationFrame((timestamp) => {
        this.frame = null
        this.scheduler = null
        this.flushFrame(timestamp)
      })
      return
    }
    this.scheduler = 'timeout'
    this.frame = window.setTimeout(() => {
      this.frame = null
      this.scheduler = null
      this.flushNow()
    }, FALLBACK_INTERVAL_MS)
  }

  private cancelScheduled(): void {
    if (this.frame === null) {
      return
    }
    if (this.scheduler === 'animation-frame') {
      window.cancelAnimationFrame(this.frame)
    } else {
      window.clearTimeout(this.frame)
    }
    this.frame = null
    this.scheduler = null
  }

  private canUseAnimationFrame(): boolean {
    return (
      typeof window.requestAnimationFrame === 'function' && document.visibilityState === 'visible'
    )
  }

  private bufferedLength(): number {
    let length = 0
    for (const buffered of this.buffers.values()) {
      length += buffered.text.length
    }
    return length
  }

  private hasRateLimitedBuffers(): boolean {
    return [...this.buffers.values()].some((buffered) => buffered.charsPerSecond !== undefined)
  }
}

function targetKey(target: StreamingTextFrameTarget): string {
  return `${target.scopeId}\u0000${target.messageId}\u0000${target.blockIndex}`
}
