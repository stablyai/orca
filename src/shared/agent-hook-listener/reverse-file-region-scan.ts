import { closeSync, openSync, readSync, statSync } from 'node:fs'

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
        // Short reads mean the file shrank; earlier block positions no longer align.
        if (filled < chunkSize) {
          return undefined
        }
        bytesRead += filled
        scanEnd = position
        // Carry has no newline; search only the new block.
        const firstNewline = buffer.indexOf(0x0a)
        let region: Buffer
        let regionPosition = position
        if (position === 0) {
          // Only BOF proves a leading partial line is whole; byte-capped scans must discard it.
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
