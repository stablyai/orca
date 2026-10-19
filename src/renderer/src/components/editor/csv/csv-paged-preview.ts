import { MAX_FILE_RANGE_READ_BYTES } from '../../../../../shared/file-range-read'
import { readRuntimeFileRange, statRuntimeReadTarget } from '@/runtime/runtime-file-range-client'
import type { CsvFilePreview } from './csv-file-content'
import {
  CSV_MAX_PAGE_BYTES,
  csvPageForRow,
  type CsvIndex,
  type CsvPageRange
} from './csv-byte-index'
import { CsvPreviewWorkerClient } from './csv-preview-worker-client'

const CACHE_CELLS = 512 * 1024
const CACHE_BYTES = 8 * 1024 * 1024
const CACHE_PAGES = 64
type CachedPage = { rows: string[][]; cells: number; bytes: number }

export class CsvPagedPreview {
  private worker = new CsvPreviewWorkerClient()
  private cache = new Map<number, CachedPage>()
  private cacheCells = 0
  private cacheBytes = 0
  private canceled = false

  constructor(private readonly file: CsvFilePreview) {}

  async validateSnapshot(): Promise<void> {
    this.checkCanceled()
    const current = await statRuntimeReadTarget(this.file.readArgs)
    if (
      current.size !== this.file.snapshot.size ||
      current.mtime !== this.file.snapshot.mtime ||
      current.isDirectory
    ) {
      this.clearCache()
      throw new Error('CSV changed on disk. Reload the file to refresh the preview.')
    }
    this.checkCanceled()
  }

  async read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    this.checkCanceled()
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > this.file.snapshot.size ||
      end - start > CSV_MAX_PAGE_BYTES
    ) {
      throw new Error('Invalid CSV page range')
    }
    const bytes = new Uint8Array(end - start)
    let received = 0
    while (received < bytes.length) {
      this.checkCanceled()
      const chunk = await readRuntimeFileRange(
        this.file.readArgs,
        start + received,
        Math.min(MAX_FILE_RANGE_READ_BYTES, bytes.length - received)
      )
      this.checkCanceled()
      bytes.set(chunk, received)
      received += chunk.length
    }
    return bytes
  }

  async buildIndex(delimiter: string, onProgress: (bytes: number) => void): Promise<CsvIndex> {
    await this.validateSnapshot()
    await this.worker.request({ kind: 'init', delimiter })
    for (let offset = 0; offset < this.file.snapshot.size;) {
      const end = Math.min(this.file.snapshot.size, offset + MAX_FILE_RANGE_READ_BYTES)
      const bytes = await this.read(offset, end)
      await this.worker.request({ kind: 'feed', bytes })
      offset = end
      onProgress(offset)
    }
    await this.validateSnapshot()
    const value = await this.worker.request({ kind: 'finish' })
    if (value.kind !== 'index') {
      throw new Error('CSV worker did not return an index')
    }
    return value.index
  }

  async page(pageIndex: number, range: CsvPageRange): Promise<string[][]> {
    await this.validateSnapshot()
    const rows = await this.loadPage(pageIndex, range)
    await this.validateSnapshot()
    return rows
  }

  async rows(
    index: CsvIndex,
    first: number,
    last: number,
    isStale: () => boolean
  ): Promise<Map<number, string[]> | null> {
    await this.validateSnapshot()
    const rows = new Map<number, string[]>()
    const firstPage = csvPageForRow(index.pages, first + 1)
    const lastPage = csvPageForRow(index.pages, last + 1)
    for (let pageIndex = firstPage; pageIndex <= lastPage; pageIndex += 1) {
      this.checkCanceled()
      if (isStale()) {
        return null
      }
      const range = index.pages[pageIndex]
      if (!range) {
        continue
      }
      const page = await this.loadPage(pageIndex, range)
      page.forEach((row, offset) => {
        const bodyIndex = range.firstRow + offset - 1
        if (bodyIndex >= first && bodyIndex <= last) {
          rows.set(bodyIndex, row)
        }
      })
    }
    if (isStale()) {
      return null
    }
    await this.validateSnapshot()
    return rows
  }

  private async loadPage(pageIndex: number, range: CsvPageRange): Promise<string[][]> {
    this.checkCanceled()
    const cached = this.cache.get(pageIndex)
    if (cached) {
      this.cache.delete(pageIndex)
      this.cache.set(pageIndex, cached)
      return cached.rows
    }
    const bytes = await this.read(range.start, range.end)
    const value = await this.worker.request({ kind: 'parse', bytes, stripBom: range.start === 0 })
    if (value.kind !== 'rows' || value.rows.length !== range.rowCount) {
      throw new Error('CSV page boundary mismatch. Reload the preview.')
    }
    this.checkCanceled()
    const previous = this.cache.get(pageIndex)
    this.cacheCells -= previous?.cells ?? 0
    this.cacheBytes -= previous?.bytes ?? 0
    const entry = {
      rows: value.rows,
      cells: value.rows.reduce((sum, row) => sum + row.length, 0),
      bytes: range.end - range.start
    }
    this.cache.delete(pageIndex)
    this.cache.set(pageIndex, entry)
    this.cacheCells += entry.cells
    this.cacheBytes += entry.bytes
    while (
      this.cache.size > CACHE_PAGES ||
      this.cacheCells > CACHE_CELLS ||
      this.cacheBytes > CACHE_BYTES
    ) {
      const first = this.cache.keys().next().value
      if (first === undefined) {
        break
      }
      const evicted = this.cache.get(first)
      this.cacheCells -= evicted?.cells ?? 0
      this.cacheBytes -= evicted?.bytes ?? 0
      this.cache.delete(first)
    }
    return value.rows
  }

  close(): void {
    this.canceled = true
    this.clearCache()
    this.worker.close()
  }

  private clearCache(): void {
    this.cache.clear()
    this.cacheCells = 0
    this.cacheBytes = 0
  }

  private checkCanceled(): void {
    if (this.canceled) {
      throw new Error('CSV preview was canceled')
    }
  }
}
