export const CSV_RECORD_BYTES = 1024 * 1024
// A first page can also contain a UTF-8 BOM and a trailing CRLF.
export const CSV_MAX_PAGE_BYTES = CSV_RECORD_BYTES + 5
export const CSV_MAX_COLUMNS = 4096
const PAGE_ROWS = 256
const PAGE_BYTES = 64 * 1024
export const CSV_PAGE_CELLS = 16 * 1024
const MAX_PAGES = 100_000

export type CsvPageRange = { start: number; end: number; firstRow: number; rowCount: number }
export type CsvIndex = { pages: CsvPageRange[]; rowCount: number; columnCount: number }

/** Record boundaries use ASCII bytes, so multibyte text never needs decoding during the scan. */
export class CsvByteIndex {
  private position = 0
  private rowStart = 0
  private pageStart = 0
  private pageFirstRow = 0
  private pageCells = 0
  private rowCount = 0
  private columns = 1
  private columnCount = 0
  private fieldEmpty = true
  private hasContent = false
  private inQuotes = false
  private pendingQuote = false
  private pendingCR = false
  private prefix: number[] = []
  private pages: CsvPageRange[] = []

  constructor(private readonly delimiter: number) {}

  feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      const at = this.position++
      if (at < 3) {
        this.prefix.push(byte)
        if (at === 2) {
          this.consumePrefix()
        }
      } else {
        this.consume(byte, at)
      }
    }
  }

  finish(): CsvIndex {
    if (this.position < 3) {
      this.consumePrefix()
    }
    if (this.pendingCR || this.hasContent || this.columns > 1) {
      this.emitRow(this.position, this.position - (this.pendingCR ? 1 : 0))
    }
    this.checkpoint(this.position)
    return { pages: this.pages, rowCount: this.rowCount, columnCount: this.columnCount }
  }

  private consumePrefix(): void {
    if (this.prefix[0] === 239 && this.prefix[1] === 187 && this.prefix[2] === 191) {
      this.rowStart = 3
    } else {
      this.prefix.forEach((byte, at) => this.consume(byte, at))
    }
    this.prefix = []
  }

  private checkpoint(end: number): void {
    if (this.rowCount === this.pageFirstRow) {
      return
    }
    if (this.pages.length >= MAX_PAGES) {
      throw new Error('CSV has too many pages to preview safely.')
    }
    this.pages.push({
      start: this.pageStart,
      end,
      firstRow: this.pageFirstRow,
      rowCount: this.rowCount - this.pageFirstRow
    })
    this.pageStart = end
    this.pageFirstRow = this.rowCount
    this.pageCells = 0
  }

  private emitRow(end: number, contentEnd = end): void {
    if (contentEnd - this.rowStart > CSV_RECORD_BYTES) {
      throw new Error('CSV record exceeds the 1 MB preview limit.')
    }
    if (end - this.pageStart > PAGE_BYTES || this.pageCells + this.columns > CSV_PAGE_CELLS) {
      this.checkpoint(this.rowStart)
    }
    this.rowCount += 1
    this.columnCount = Math.max(this.columnCount, this.columns)
    this.pageCells += this.columns
    if (
      this.rowCount - this.pageFirstRow >= PAGE_ROWS ||
      end - this.pageStart >= PAGE_BYTES ||
      this.pageCells >= CSV_PAGE_CELLS
    ) {
      this.checkpoint(end)
    }
    this.rowStart = end
    this.columns = 1
    this.fieldEmpty = true
    this.hasContent = false
  }

  private consume(byte: number, at: number): void {
    if (this.pendingCR) {
      this.pendingCR = false
      this.emitRow(byte === 10 ? at + 1 : at, at - 1)
      if (byte === 10) {
        return
      }
    }
    const endsRecord = (byte === 13 || byte === 10) && (!this.inQuotes || this.pendingQuote)
    if (at + (endsRecord ? 0 : 1) - this.rowStart > CSV_RECORD_BYTES) {
      throw new Error('CSV record exceeds the 1 MB preview limit.')
    }
    if (byte === 0) {
      throw new Error('This file contains binary data.')
    }
    if (this.inQuotes && this.pendingQuote) {
      this.pendingQuote = false
      if (byte === 34) {
        this.fieldEmpty = false
        return
      }
      this.inQuotes = false
    }
    if (this.inQuotes) {
      if (byte === 34) {
        this.pendingQuote = true
      } else {
        this.fieldEmpty = false
      }
      return
    }
    if (byte === 34 && this.fieldEmpty) {
      this.inQuotes = true
      this.hasContent = true
      return
    }
    if (byte === this.delimiter) {
      if (++this.columns > CSV_MAX_COLUMNS) {
        throw new Error('CSV exceeds the 4,096 column preview limit.')
      }
      this.fieldEmpty = true
      this.hasContent = true
    } else if (byte === 13) {
      this.pendingCR = true
    } else if (byte === 10) {
      this.emitRow(at + 1, at)
    } else {
      this.fieldEmpty = false
      this.hasContent = true
    }
  }
}

export function csvPageForRow(pages: CsvPageRange[], row: number): number {
  let low = 0
  let high = pages.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (pages[mid]!.firstRow <= row) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low
}
