import type { SearchAccumulator } from './text-search'

const MAX_SEARCH_ERROR_BYTES = 4096
const MAX_STDERR_LINE_CHARS = 64 * 1024
const PER_PATH_OS_ERROR = /^rg: .+: .+ \(os error (\d+)\)\r?$/

export class RipgrepSearchDiagnostics {
  private readonly bytes = Buffer.alloc(MAX_SEARCH_ERROR_BYTES)
  private length = 0
  private partialLine = ''
  private skippedPathCount = 0
  private sawOtherError = false

  /** `skippablePathOsErrors`: per-file OS errors that mean "this host cannot open it", not a failed search. */
  constructor(private readonly skippablePathOsErrors: ReadonlySet<number> = new Set()) {}

  append(chunk: Buffer | string): void {
    if (this.skippablePathOsErrors.size > 0 && !this.sawOtherError) {
      this.classify(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    }
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
    if (code === 2 && this.onlySkippedPaths()) {
      return null
    }
    if (acc.totalMatches > 0) {
      acc.truncated = true
      return null
    }
    const detail = this.bytes.toString('utf8', 0, this.length).trim()
    return new Error(`Search failed (${signal ?? code})${detail ? `: ${detail}` : ''}`)
  }

  private classify(text: string): void {
    const lines = (this.partialLine + text).split('\n')
    this.partialLine = lines.pop() ?? ''
    if (this.partialLine.length > MAX_STDERR_LINE_CHARS) {
      this.sawOtherError = true
      return
    }
    for (const line of lines) {
      this.classifyLine(line)
    }
  }

  private classifyLine(line: string): void {
    if (!line.trim()) {
      return
    }
    const osError = PER_PATH_OS_ERROR.exec(line)?.[1]
    if (osError !== undefined && this.skippablePathOsErrors.has(Number(osError))) {
      this.skippedPathCount++
    } else {
      this.sawOtherError = true
    }
  }

  private onlySkippedPaths(): boolean {
    if (this.skippablePathOsErrors.size === 0 || this.sawOtherError) {
      return false
    }
    this.classifyLine(this.partialLine)
    this.partialLine = ''
    return !this.sawOtherError && this.skippedPathCount > 0
  }
}
