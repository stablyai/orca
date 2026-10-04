import type { SearchAccumulator } from './text-search'

const MAX_SEARCH_ERROR_BYTES = 4096

export class RipgrepSearchDiagnostics {
  private readonly bytes = Buffer.alloc(MAX_SEARCH_ERROR_BYTES)
  private length = 0

  append(chunk: Buffer | string): void {
    if (this.length >= this.bytes.length) {
      return
    }
    this.length +=
      typeof chunk === 'string'
        ? this.bytes.write(chunk, this.length, this.bytes.length - this.length, 'utf8')
        : chunk.copy(this.bytes, this.length, 0, this.bytes.length - this.length)
  }

  failure(
    code: number | null,
    signal: NodeJS.Signals | null,
    acc: SearchAccumulator
  ): Error | null {
    if (code === 0 || code === 1 || (signal && acc.truncated)) {
      return null
    }
    if (acc.totalMatches > 0) {
      acc.truncated = true
      return null
    }
    const detail = this.bytes.toString('utf8', 0, this.length).trim()
    return new Error(`Search failed (${signal ?? code})${detail ? `: ${detail}` : ''}`)
  }
}
