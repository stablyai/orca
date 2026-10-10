import { GrowingByteBuffer } from '@orca/process-host/growing-byte-buffer'

export const QUICK_OPEN_LISTING_MAX_RESULTS = 20_001
const QUICK_OPEN_LISTING_MAX_PATH_BYTES = 64 * 1024

export function resolveQuickOpenResultLimit(requested?: number): number {
  if (requested === undefined || requested === Number.POSITIVE_INFINITY) {
    return QUICK_OPEN_LISTING_MAX_RESULTS
  }
  if (!Number.isFinite(requested)) {
    return 0
  }
  return Math.min(Math.max(Math.trunc(requested), 0), QUICK_OPEN_LISTING_MAX_RESULTS)
}

export type QuickOpenPathAccumulatorResult = 'continue' | 'stopped' | 'path-too-large'

export class QuickOpenSubprocessPathAccumulator {
  private readonly field = new GrowingByteBuffer()

  constructor(
    private readonly delimiter: number,
    private readonly maxPathBytes = QUICK_OPEN_LISTING_MAX_PATH_BYTES
  ) {
    if (!Number.isInteger(delimiter) || delimiter < 0 || delimiter > 0xff) {
      throw new RangeError('Quick Open path delimiter must be one byte')
    }
    if (!Number.isSafeInteger(maxPathBytes) || maxPathBytes < 0) {
      throw new RangeError('Quick Open path limit must be a non-negative safe integer')
    }
  }

  push(
    rawChunk: Buffer | string,
    onPath: (path: string) => boolean
  ): QuickOpenPathAccumulatorResult {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk, 'utf8')
    let cursor = 0
    while (cursor < chunk.length) {
      const delimiter = chunk.indexOf(this.delimiter, cursor)
      const end = delimiter === -1 ? chunk.length : delimiter
      const segmentBytes = end - cursor
      if (this.field.byteLength + segmentBytes > this.maxPathBytes) {
        this.clear()
        return 'path-too-large'
      }
      if (delimiter !== -1 && this.field.byteLength === 0) {
        if (!onPath(chunk.toString('utf8', cursor, end))) {
          return 'stopped'
        }
      } else if (segmentBytes > 0) {
        // Why: copying prevents a short residual path from retaining the whole read buffer.
        this.field.append(chunk.subarray(cursor, end))
        if (delimiter !== -1 && !onPath(this.take())) {
          return 'stopped'
        }
      } else if (delimiter !== -1 && !onPath(this.take())) {
        return 'stopped'
      }
      if (delimiter === -1) {
        return 'continue'
      }
      cursor = delimiter + 1
    }
    return 'continue'
  }

  finish(): string | null {
    return this.field.byteLength > 0 ? this.take() : null
  }

  clear(): void {
    this.field.clear()
  }

  private take(): string {
    return this.field.takeString()
  }
}
