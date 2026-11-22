import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'

/** Scan from EOF for the latest match; chunk lists avoid quadratic copies of oversized lines. visit gets whole lines and absolute byte offsets; stop on a result/budget/BOF, and treat errors as absent. */
export function scanFileRegionsBackward<T>(
  filePath: string,
  limits: { chunkBytes: number; maxScanBytes: number },
  visit: (region: Buffer, regionPosition: number) => T | undefined
): T | undefined {
  try {
    const size = statSync(filePath).size
    if (size <= 0) {
      return undefined
    }
    const fd = openSync(filePath, 'r')
    try {
      const carryChunks: Buffer[] = []
      let bytesRead = 0
      let scanEnd = size
      while (scanEnd > 0 && bytesRead < limits.maxScanBytes) {
        const chunkSize = Math.min(scanEnd, limits.chunkBytes, limits.maxScanBytes - bytesRead)
        const position = scanEnd - chunkSize
        const buffer = Buffer.alloc(chunkSize)
        let filled = 0
        while (filled < chunkSize) {
          const read = readSync(fd, buffer, filled, chunkSize - filled, position + filled)
          if (read === 0) {
            break
          }
          filled += read
        }
        // Short reads mean the file shrank; earlier block positions no longer align.
        if (filled < chunkSize) {
          return undefined
        }
        bytesRead += filled
        scanEnd = position
        const { region, regionPosition } = nextRegion(buffer, position, carryChunks)
        if (region.length > 0) {
          const found = visit(region, regionPosition)
          if (found !== undefined) {
            return found
          }
        }
      }
      return undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** The async twin, for callers on the event loop: same regions, same budget, same visit order. */
export async function scanFileRegionsBackwardAsync<T>(
  filePath: string,
  /** `floor`: an earlier scan already searched the whole lines before this byte; stop there, but
   *  finish a line that crosses it. */
  limits: { chunkBytes: number; maxScanBytes: number; floor?: number },
  visit: (region: Buffer, regionPosition: number) => T | undefined,
  /** Checked before each read; a superseded scan stops instead of reading on. */
  keepReading: () => boolean = () => true,
  /** A scan that couldn't open or read the file, as opposed to one that found nothing. */
  onError?: () => void
): Promise<T | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const size = (await handle.stat()).size
    const carryChunks: Buffer[] = []
    let bytesRead = 0
    let scanEnd = size
    const floor = limits.floor ?? 0
    const carriedLineEnd = () => carryChunks.reduce((end, chunk) => end + chunk.length, scanEnd)
    while (
      scanEnd > 0 &&
      (scanEnd > floor || carriedLineEnd() > floor) &&
      bytesRead < limits.maxScanBytes &&
      keepReading()
    ) {
      const chunkSize = Math.min(scanEnd, limits.chunkBytes, limits.maxScanBytes - bytesRead)
      const position = scanEnd - chunkSize
      const buffer = Buffer.alloc(chunkSize)
      let filled = 0
      while (filled < chunkSize) {
        const { bytesRead: read } = await handle.read(
          buffer,
          filled,
          chunkSize - filled,
          position + filled
        )
        if (read === 0) {
          break
        }
        filled += read
      }
      if (filled < chunkSize) {
        // The file shrank mid-scan: report it so a retry reads in full rather than trusting its size.
        onError?.()
        return undefined
      }
      bytesRead += filled
      scanEnd = position
      const { region, regionPosition } = nextRegion(buffer, position, carryChunks)
      if (region.length > 0) {
        const found = visit(region, regionPosition)
        if (found !== undefined) {
          return found
        }
      }
    }
    return undefined
  } catch {
    onError?.()
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Whole lines of the block just read; the partial first line carries into the next (earlier) block. */
function nextRegion(
  buffer: Buffer,
  position: number,
  carryChunks: Buffer[]
): { region: Buffer; regionPosition: number } {
  if (position === 0) {
    // Only BOF proves a leading partial line is whole; byte-capped scans must discard it.
    const region = carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
    carryChunks.length = 0
    return { region, regionPosition: position }
  }
  // Carry has no newline; search only the new block.
  const firstNewline = buffer.indexOf(0x0a)
  if (firstNewline === -1) {
    carryChunks.unshift(buffer)
    return { region: EMPTY_REGION, regionPosition: position }
  }
  const afterNewline = buffer.subarray(firstNewline + 1)
  const region =
    carryChunks.length === 0 ? afterNewline : Buffer.concat([afterNewline, ...carryChunks])
  carryChunks.length = 0
  carryChunks.push(buffer.subarray(0, firstNewline))
  return { region, regionPosition: position + firstNewline + 1 }
}

const EMPTY_REGION = Buffer.alloc(0)
