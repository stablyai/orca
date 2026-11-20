import {
  transcriptDigestHex,
  type TranscriptByteRange
} from '../../../../../../../shared/native-chat/transcript/transcript-byte-range'

function mergeRanges(ranges: readonly TranscriptByteRange[]): TranscriptByteRange[] {
  const merged: TranscriptByteRange[] = []
  for (const range of ranges.toSorted((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1)
    if (last && range.end <= last.end) {
      continue
    }
    if (last?.end === range.start) {
      merged[merged.length - 1] = {
        start: last.start,
        end: range.end,
        digest: transcriptDigestHex(BigInt(`0x${last.digest}`) + BigInt(`0x${range.digest}`))
      }
    } else {
      merged.push(range)
    }
  }
  return merged
}

type VerificationOptions<T> = {
  visible: () => boolean
  verify?: (ranges: TranscriptByteRange[], signal: AbortSignal) => Promise<boolean[] | null>
  reread: (signal: AbortSignal) => Promise<T>
  apply: (result: T | undefined) => TranscriptByteRange[] | undefined
}

export class NativeChatHeldHistoryVerify<T> {
  private ranges: TranscriptByteRange[] = []
  private window: TranscriptByteRange[] = []
  private unverified = false
  private generation = 0
  private revision = 0
  private pending = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: AbortController | undefined

  constructor(private readonly options: VerificationOptions<T>) {}

  reset(ranges?: TranscriptByteRange[]): void {
    this.clear()
    this.ranges = mergeRanges(ranges ?? [])
    this.window = this.ranges
    this.unverified = ranges === undefined
  }

  reread(ranges?: TranscriptByteRange[]): void {
    const window = this.window
    this.reset(ranges)
    if (window.length > 0) {
      this.window = window
    }
  }

  prepend(ranges?: TranscriptByteRange[]): void {
    this.ranges = mergeRanges([...(ranges ?? []), ...this.ranges])
    this.unverified ||= ranges === undefined
    this.revision++
    if (this.running) {
      this.schedule()
    }
  }

  append(ranges?: TranscriptByteRange[]): void {
    this.ranges = mergeRanges([...this.ranges, ...(ranges ?? [])])
    this.window = mergeRanges([...this.window, ...(ranges ?? [])])
    this.unverified ||= ranges === undefined
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
    if (keepWholeProof) {
      this.unverified ||= !ranges?.every((range) =>
        this.ranges.some((held) => held.start <= range.start && held.end >= range.end)
      )
    } else {
      this.ranges = mergeRanges([...prefix, ...(ranges ?? [])])
      this.unverified ||= prefix.length === 0
    }
    this.window = mergeRanges(ranges ?? [])
    this.unverified ||= ranges === undefined || first === undefined
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
    this.unverified = false
  }

  private schedule(): void {
    this.pending = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.running) {
        void this.run()
      }
    }, 1_000)
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
      let matched = false
      if (!this.unverified && this.ranges.length > 0 && this.options.verify) {
        try {
          const result = await this.options.verify(this.ranges, controller.signal)
          matched = result !== null && result.length === this.ranges.length && result.every(Boolean)
        } catch {
          if (controller.signal.aborted) {
            return
          }
        }
      }
      if (matched || !current()) {
        return
      }
      let result: T | undefined
      try {
        result = await this.options.reread(controller.signal)
      } catch {
        if (controller.signal.aborted) {
          return
        }
      }
      if (current()) {
        this.reread(this.options.apply(result))
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
