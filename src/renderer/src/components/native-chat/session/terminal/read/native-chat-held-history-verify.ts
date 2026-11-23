import {
  mergeTranscriptRanges,
  TRANSCRIPT_RANGES_UNSETTLED,
  transcriptDigestHex,
  type TranscriptByteRange,
  type TranscriptRangeVerification
} from '../../../../../../../shared/native-chat/transcript/transcript-byte-range'

type VerificationOptions<T> = {
  visible: () => boolean
  olderSpan: () => { start: number; end: number } | undefined
  verify?: (
    ranges: TranscriptByteRange[],
    signal: AbortSignal
  ) => Promise<TranscriptRangeVerification | null>
  reread: (signal: AbortSignal) => Promise<T>
  /** False leaves the held rows as they are; `superseded` means a newer window landed during the re-read. */
  apply: (result: T | undefined, superseded: boolean) => TranscriptByteRange[] | undefined | false
}

const MAX_TIMED_RETRIES = 3

export class NativeChatHeldHistoryVerify<T> {
  private ranges: TranscriptByteRange[] = []
  private window: TranscriptByteRange[] = []
  private unsupported = false
  // A known mismatch goes straight to the re-read instead of verifying again.
  private stale = false
  // Unsettled verifies and refused re-reads back off, then wait for the next transcript frame, so a file that never settles isn't re-hashed forever.
  private backoff = 0
  private generation = 0
  private revision = 0
  private pending = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: AbortController | undefined

  constructor(private readonly options: VerificationOptions<T>) {}

  get supported(): boolean {
    return !!this.options.verify && !this.unsupported
  }

  reset(ranges?: TranscriptByteRange[]): void {
    this.clear()
    this.ranges = mergeTranscriptRanges(ranges ?? [])
    this.window = this.ranges
  }

  reread(ranges?: TranscriptByteRange[]): void {
    const window = this.window
    this.reset(ranges)
    if (window.length > 0) {
      this.window = window
    }
  }

  prepend(ranges?: TranscriptByteRange[]): void {
    this.ranges = mergeTranscriptRanges([...(ranges ?? []), ...this.ranges])
    this.revision++
    if (this.running) {
      this.schedule()
    }
  }

  append(ranges?: TranscriptByteRange[]): void {
    this.ranges = mergeTranscriptRanges([...this.ranges, ...(ranges ?? [])])
    this.window = mergeTranscriptRanges([...this.window, ...(ranges ?? [])])
    if (this.backoff > MAX_TIMED_RETRIES) {
      this.schedule()
    }
  }

  replacement(ranges: TranscriptByteRange[] | undefined, kept: boolean): void {
    if (!kept) {
      this.reset(ranges)
      return
    }
    const first = ranges?.[0]?.start
    const prefix: TranscriptByteRange[] = []
    let keepWholeProof = false
    for (const range of this.ranges) {
      if (first !== undefined && range.end <= first) {
        prefix.push(range)
      } else if (first !== undefined && range.start < first) {
        const oldWindow = this.window[0]
        if (this.window.length === 1 && oldWindow?.start === first && oldWindow.end === range.end) {
          prefix.push({
            start: range.start,
            end: first,
            digest: transcriptDigestHex(
              BigInt(`0x${range.digest}`) - BigInt(`0x${oldWindow.digest}`)
            )
          })
        } else {
          keepWholeProof = true
        }
      }
    }
    if (first !== undefined && !keepWholeProof) {
      this.ranges = mergeTranscriptRanges([...prefix, ...(ranges ?? [])])
    }
    this.window = mergeTranscriptRanges(ranges ?? [])
    this.revision++
    this.schedule()
  }

  clear(): void {
    this.generation++
    this.revision++
    this.pending = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
    }
    this.timer = undefined
    this.running?.abort()
    this.ranges = []
    this.window = []
    this.stale = false
    this.backoff = 0
  }

  private applyResult(result: T | undefined, superseded: boolean): void {
    const ranges = this.options.apply(result, superseded)
    if (ranges === false) {
      this.retryLater()
      return
    }
    this.reread(ranges)
    // The newer window arrived after the re-read began, so its bytes still need a check.
    if (superseded) {
      this.schedule()
    }
  }

  private retryLater(): void {
    this.backoff++
    if (this.backoff <= MAX_TIMED_RETRIES) {
      this.schedule()
    }
  }

  private schedule(): void {
    this.pending = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        if (!this.running) {
          void this.run()
        }
      },
      1_000 * 2 ** Math.min(this.backoff, 5)
    )
  }

  private async run(): Promise<void> {
    if (!this.pending || !this.options.visible()) {
      return
    }
    this.pending = false
    const controller = new AbortController()
    this.running = controller
    const generation = this.generation
    const revision = this.revision
    const current = (): boolean =>
      !controller.signal.aborted &&
      this.generation === generation &&
      this.revision === revision &&
      this.options.visible()
    try {
      if (!this.supported) {
        if (current()) {
          this.applyResult(undefined, false)
        }
        return
      }
      const span = this.options.olderSpan()
      if (!span || span.start >= span.end) {
        return
      }
      if (!this.stale) {
        const ranges = this.ranges.filter(
          (range) => range.start < span.end && range.end > span.start
        )
        let coveredTo = span.start
        for (const range of ranges) {
          if (range.start > coveredTo) {
            break
          }
          coveredTo = Math.max(coveredTo, range.end)
        }
        if (coveredTo >= span.end && this.options.verify) {
          const result = await this.options.verify(ranges, controller.signal)
          if (controller.signal.aborted || this.generation !== generation) {
            return
          }
          if (result === null) {
            this.unsupported = true
            if (current()) {
              this.applyResult(undefined, false)
            }
            return
          }
          if (result === TRANSCRIPT_RANGES_UNSETTLED) {
            this.retryLater()
            return
          }
          this.backoff = 0
          if (result.length === ranges.length && result.every(Boolean)) {
            return
          }
        }
        this.stale = true
      }
      const live = (): boolean =>
        !controller.signal.aborted && this.generation === generation && this.options.visible()
      if (!live()) {
        return
      }
      const result = await this.options.reread(controller.signal)
      // A window that landed during the re-read keeps its rows; the re-read supplies the older prefix.
      if (live()) {
        this.applyResult(result, this.revision !== revision)
      }
    } catch {
      if (!controller.signal.aborted && this.generation === generation) {
        this.retryLater()
      }
    } finally {
      if (this.running === controller) {
        this.running = undefined
      }
      if (this.pending && this.timer === undefined) {
        void this.run()
      }
    }
  }
}
