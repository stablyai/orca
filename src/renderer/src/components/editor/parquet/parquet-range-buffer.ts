import type { AsyncBuffer } from 'hyparquet'
import { MAX_FILE_RANGE_READ_BYTES } from '../../../../../shared/file-content/file-range-read'

export type ReadFileRange = (offset: number, length: number) => Promise<Uint8Array>

// Why: two capped range replies fit the relay's control queue; a third is rejected.
const MAX_CONCURRENT_RANGE_READS = 2
const SLICE_CACHE_BYTES = 64 * 1024 * 1024

/** A hyparquet file over host range reads, keeping recent slices so scrolling one row group reads it once. */
export function createParquetRangeBuffer(
  byteLength: number,
  readRange: ReadFileRange
): AsyncBuffer {
  const cache = new Map<string, Promise<ArrayBuffer>>()
  const cachedBytes = new Map<string, number>()
  let totalCachedBytes = 0
  const remember = (key: string, size: number): void => {
    cachedBytes.set(key, size)
    totalCachedBytes += size
    for (const [oldest, oldestSize] of cachedBytes) {
      if (totalCachedBytes <= SLICE_CACHE_BYTES || oldest === key) {
        break
      }
      cache.delete(oldest)
      cachedBytes.delete(oldest)
      totalCachedBytes -= oldestSize
    }
  }
  return {
    byteLength,
    slice(start, end = byteLength) {
      const from = Math.max(0, start < 0 ? byteLength + start : start)
      const to = Math.min(byteLength, end)
      const key = `${from}:${to}`
      const cached = cache.get(key)
      if (cached) {
        cache.delete(key)
        cache.set(key, cached)
        const size = cachedBytes.get(key) ?? 0
        cachedBytes.delete(key)
        cachedBytes.set(key, size)
        return cached
      }
      const read = readByteRange(from, to, readRange)
      cache.set(key, read)
      read.then(
        (buffer) => {
          if (cache.get(key) === read) {
            remember(key, buffer.byteLength)
          }
        },
        () => cache.delete(key)
      )
      return read
    }
  }
}

async function readByteRange(
  start: number,
  end: number,
  readRange: ReadFileRange
): Promise<ArrayBuffer> {
  const output = new Uint8Array(Math.max(0, end - start))
  const offsets: number[] = []
  for (let offset = start; offset < end; offset += MAX_FILE_RANGE_READ_BYTES) {
    offsets.push(offset)
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < offsets.length) {
      const offset = offsets[next++]!
      const length = Math.min(MAX_FILE_RANGE_READ_BYTES, end - offset)
      const bytes = await readRange(offset, length)
      if (bytes.length !== length) {
        throw new Error('Parquet file changed while it was being read. Reload the preview.')
      }
      output.set(bytes, offset - start)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_RANGE_READS, offsets.length) }, worker)
  )
  return output.buffer
}
