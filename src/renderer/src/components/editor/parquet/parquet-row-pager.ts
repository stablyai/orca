import {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  type AsyncBuffer,
  type FileMetaData
} from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import type { RuntimeFileReadArgs } from '@/runtime/files/runtime-file-client-types'
import {
  readRuntimeFileRange,
  statRuntimeReadTarget
} from '@/runtime/files/reads/runtime-file-range-client'
import { createParquetRangeBuffer } from './parquet-range-buffer'
import { parquetCellText } from './parquet-cell-text'

const PAGE_ROWS = 500
// Bounds decoded rows held while scrolling a large file.
const MAX_CACHED_PAGES = 24

/** Decodes a Parquet file's rows page by page, newest request first, keeping recent pages. */
export class ParquetRowPager {
  private readonly pages = new Map<number, string[][]>()
  private wanted: number[] = []
  private loading = false
  private closed = false

  private constructor(
    private readonly file: AsyncBuffer,
    private readonly metadata: FileMetaData,
    readonly header: string[],
    readonly rowCount: number
  ) {}

  static async open(
    readArgs: RuntimeFileReadArgs,
    byteSize: number | undefined
  ): Promise<ParquetRowPager> {
    const size = byteSize ?? (await statRuntimeReadTarget(readArgs)).size
    const file = createParquetRangeBuffer(size, (offset, length) =>
      readRuntimeFileRange(readArgs, offset, length)
    )
    const metadata = await parquetMetadataAsync(file)
    const header = parquetSchema(metadata).children.map((column) => column.element.name)
    return new ParquetRowPager(file, metadata, header, Number(metadata.num_rows))
  }

  async firstRows(): Promise<Map<number, string[]>> {
    if (this.rowCount > 0) {
      this.pages.set(0, await this.readPage(0))
    }
    return this.rows()
  }

  /** Loads the pages covering the visible rows; a newer request replaces pages still queued. */
  request(
    first: number,
    last: number,
    onRows: (rows: Map<number, string[]>) => void
  ): Promise<void> {
    const needed: number[] = []
    for (let page = Math.floor(first / PAGE_ROWS); page <= Math.floor(last / PAGE_ROWS); page++) {
      const cached = this.pages.get(page)
      if (cached) {
        // Why: refresh recency so visible pages outlive pages scrolled past.
        this.pages.delete(page)
        this.pages.set(page, cached)
      } else {
        needed.push(page)
      }
    }
    this.wanted = needed
    return this.drain(onRows)
  }

  close(): void {
    this.closed = true
    this.wanted = []
  }

  private async drain(onRows: (rows: Map<number, string[]>) => void): Promise<void> {
    if (this.loading) {
      return
    }
    this.loading = true
    try {
      while (this.wanted.length > 0 && !this.closed) {
        const page = this.wanted.shift()!
        if (this.pages.has(page)) {
          continue
        }
        const rows = await this.readPage(page)
        if (this.closed) {
          return
        }
        this.pages.set(page, rows)
        for (const cachedPage of this.pages.keys()) {
          if (this.pages.size <= MAX_CACHED_PAGES) {
            break
          }
          this.pages.delete(cachedPage)
        }
        onRows(this.rows())
      }
    } finally {
      this.loading = false
    }
  }

  private rows(): Map<number, string[]> {
    const rows = new Map<number, string[]>()
    for (const [page, pageRows] of this.pages) {
      pageRows.forEach((row, offset) => rows.set(page * PAGE_ROWS + offset, row))
    }
    return rows
  }

  private readPage(page: number): Promise<string[][]> {
    const rowStart = page * PAGE_ROWS
    return new Promise((resolve, reject) => {
      parquetRead({
        file: this.file,
        metadata: this.metadata,
        compressors,
        rowStart,
        rowEnd: Math.min(this.rowCount, rowStart + PAGE_ROWS),
        rowFormat: 'array',
        useOffsetIndex: true,
        onComplete: (rows) => resolve(rows.map((row) => row.map(parquetCellText)))
      }).catch(reject)
    })
  }
}
