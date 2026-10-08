import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Walk a file backwards in chunks, handing each caller a region of whole lines.
 *
 * Why backward: every caller wants the LAST entry that matches, so walking up from
 * EOF returns on the first hit instead of parsing every line of a multi-megabyte
 * transcript on every hook event.
 *
 * Why a chunk list rather than a growing buffer: `carry` holds the partial line that
 * straddles a block boundary, and re-concatenating it per block made one oversized
 * line (a big tool result or pasted prompt) cost O(line²).
 *
 * `visit` receives only whole lines, and the byte offset that region starts at.
 * The scan stops at the first defined result, at the byte budget, or at the file
 * start — whichever comes first. Any error reads as "nothing found".
 */
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
      let carryChunks: Buffer[] = []
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
        // Why bail on a short read: the file shrank under us, so the bytes above this
        // block no longer line up with what the earlier ones assumed.
        if (filled < chunkSize) {
          return undefined
        }
        bytesRead += filled
        scanEnd = position
        // Why search only the new block: carry is always the run before a newline, so
        // it holds none of its own.
        const firstNewline = buffer.indexOf(0x0a)
        let region: Buffer
        let regionPosition = position
        if (position === 0) {
          // Only at a true file start is the leading partial line a whole line. A scan
          // that stops on the byte cap must discard it, as a capped read would.
          region = carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
          carryChunks = []
        } else if (firstNewline === -1) {
          region = EMPTY_REGION
          carryChunks.unshift(buffer)
        } else {
          const afterNewline = buffer.subarray(firstNewline + 1)
          region =
            carryChunks.length === 0 ? afterNewline : Buffer.concat([afterNewline, ...carryChunks])
          regionPosition = position + firstNewline + 1
          carryChunks = [buffer.subarray(0, firstNewline)]
        }
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

const EMPTY_REGION = Buffer.alloc(0)
