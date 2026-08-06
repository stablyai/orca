export const SEARCH_SUBPROCESS_MAX_LINE_BYTES = 64 * 1024 * 1024
const SEARCH_SUBPROCESS_INITIAL_LINE_BUFFER_BYTES = 4 * 1024

export class SearchSubprocessLineAccumulator {
  private buffer: Buffer | null = null
  private bytes = 0

  constructor(private readonly maxLineBytes = SEARCH_SUBPROCESS_MAX_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 0) {
      throw new RangeError('Search line limit must be a non-negative safe integer')
    }
  }

  push(rawChunk: Buffer | string, onLine: (line: string) => void): boolean {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk, 'utf8')
    let cursor = 0
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor)
      const end = newline === -1 ? chunk.length : newline
      const segmentBytes = end - cursor
      if (this.bytes + segmentBytes > this.maxLineBytes) {
        this.clear()
        return false
      }

      if (newline !== -1 && this.bytes === 0) {
        onLine(chunk.toString('utf8', cursor, end))
      } else if (segmentBytes > 0) {
        this.append(chunk.subarray(cursor, end))
        if (newline !== -1) {
          onLine(this.takeLine())
        }
      } else if (newline !== -1) {
        onLine(this.takeLine())
      }

      if (newline === -1) {
        return true
      }
      cursor = newline + 1
    }
    return true
  }

  finish(): string | null {
    return this.bytes > 0 ? this.takeLine() : null
  }

  clear(): void {
    this.buffer = null
    this.bytes = 0
  }

  private append(segment: Buffer): void {
    const requiredBytes = this.bytes + segment.length
    if (!this.buffer || this.buffer.length < requiredBytes) {
      const doubledCapacity = this.buffer?.length ? this.buffer.length * 2 : 0
      const nextCapacity = Math.min(
        this.maxLineBytes,
        Math.max(SEARCH_SUBPROCESS_INITIAL_LINE_BUFFER_BYTES, doubledCapacity, requiredBytes)
      )
      const next = Buffer.allocUnsafe(nextCapacity)
      this.buffer?.copy(next, 0, 0, this.bytes)
      this.buffer = next
    }
    segment.copy(this.buffer, this.bytes)
    this.bytes = requiredBytes
  }

  private takeLine(): string {
    const line = this.buffer?.toString('utf8', 0, this.bytes) ?? ''
    this.clear()
    return line
  }
}
