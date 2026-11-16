import type { AsyncBuffer } from 'hyparquet'
import { PrioritySemaphore } from '../../../../../shared/concurrency/priority-semaphore'
import {
  MAX_CONCURRENT_FILE_RANGE_READS,
  MAX_FILE_RANGE_READ_BYTES
} from '../../../../../shared/file-content/file-range-read'

export type ReadFileRange = (offset: number, length: number) => Promise<Uint8Array>

const SLICE_CACHE_BYTES = 64 * 1024 * 1024

/** A hyparquet file over host range reads, keeping recent slices so scrolling one row group reads it once. */
export function createParquetRangeBuffer(
  byteLength: number,
  readRange: ReadFileRange
): AsyncBuffer {
  // Why: hyparquet requests several slices at once; this caps one preview's reads, and a remote host also caps all its readers.
  const slots = new PrioritySemaphore(MAX_CONCURRENT_FILE_RANGE_READS)
  const cache = new Map<string, Promise<ArrayBuffer>>()
  const cachedBytes = new Map<string, number>()
  let totalCachedBytes = 0
  const remember = (key: string, size: number): void => {
    if (size > SLICE_CACHE_BYTES) {
      cache.delete(key)
      return
    }
    cachedBytes.set(key, size)
    totalCachedBytes += size
    for (const [oldest, oldestSize] of cachedBytes) {
      if (totalCachedBytes <= SLICE_CACHE_BYTES) {
        break
      }
      if (oldest === key) {
        continue
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
        const size = cachedBytes.get(key)
        if (size !== undefined) {
          cachedBytes.delete(key)
          cachedBytes.set(key, size)
        }
        return cached
      }
      const read = readByteRange(from, to, readRange, slots)
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
  readRange: ReadFileRange,
  slots: PrioritySemaphore
): Promise<ArrayBuffer> {
  const output = new Uint8Array(Math.max(0, end - start))
  let failed = false
  const reads: Promise<void>[] = []
  for (let offset = start; offset < end; offset += MAX_FILE_RANGE_READ_BYTES) {
    const length = Math.min(MAX_FILE_RANGE_READ_BYTES, end - offset)
    reads.push(
      readChunkInSlot(slots, async () => {
        // Why: a failed slice rejects once; its queued reads should not keep the host busy.
        if (failed) {
          return
        }
        const bytes = await readRange(offset, length)
        if (bytes.length !== length) {
          throw new Error('Parquet file changed while it was being read. Reload the preview.')
        }
        output.set(bytes, offset - start)
      }).catch((error: unknown) => {
        failed = true
        throw error
      })
    )
  }
  await Promise.all(reads)
  return output.buffer
}

async function readChunkInSlot(slots: PrioritySemaphore, read: () => Promise<void>): Promise<void> {
  const release = await slots.acquire(0)
  try {
    await read()
  } finally {
    release()
  }
}
