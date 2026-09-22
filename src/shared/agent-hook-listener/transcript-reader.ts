import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'

import { extractAssistantTextFromLine } from './transcript-entry-text'

export const TRANSCRIPT_CHUNK_BYTES = 64 * 1024
export const TRANSCRIPT_MAX_SCAN_BYTES = 4 * 1024 * 1024
export const EMPTY_TRANSCRIPT_REGION = Buffer.alloc(0)

/** Open a transcript without following a swapped symlink or blocking on a FIFO.
 *  Windows has no O_NOFOLLOW (the constant is 0). A pre-open lstat refuses a
 *  symlink we can already see; POSIX still fails a swap between that check and
 *  open because O_NOFOLLOW is set. Returning undefined whenever no-follow is
 *  missing would stop every Windows transcript read. */
export function openAgentTranscriptRead(
  transcriptPath: string,
  options?: { allowEmpty?: boolean }
): { fd: number; size: number } | undefined {
  try {
    if (lstatSync(transcriptPath).isSymbolicLink()) {
      return undefined
    }
  } catch {
    return undefined
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  let fd: number
  try {
    fd = openSync(transcriptPath, flags)
  } catch {
    return undefined
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || (!options?.allowEmpty && stats.size <= 0)) {
      closeSync(fd)
      return undefined
    }
    return { fd, size: stats.size }
  } catch {
    closeSync(fd)
    return undefined
  }
}

export function readLastAssistantFromTranscriptOnce(transcriptPath: string): string | undefined {
  return readLastTextFromTranscriptOnce(transcriptPath, extractAssistantTextFromLine)
}

export function readLastTextFromTranscriptOnce(
  transcriptPath: string,
  extractLineText: (line: string) => string | undefined
): string | undefined {
  try {
    const opened = openAgentTranscriptRead(transcriptPath)
    if (!opened) {
      return undefined
    }
    const { fd, size } = opened
    try {
      // Why a chunk list: carry holds a partial line, and re-joining it per block
      // made one oversized line (a big tool result or pasted prompt) cost O(line^2).
      let carryChunks: Buffer[] = []
      let bytesRead = 0
      let scanEnd = size
      while (scanEnd > 0 && bytesRead < TRANSCRIPT_MAX_SCAN_BYTES) {
        const chunkSize = Math.min(scanEnd, TRANSCRIPT_CHUNK_BYTES)
        const position = scanEnd - chunkSize
        const buffer = Buffer.alloc(chunkSize)
        let filled = 0
        while (filled < chunkSize) {
          const n = readSync(fd, buffer, filled, chunkSize - filled, position + filled)
          if (n === 0) {
            break
          }
          filled += n
        }
        // Why bail on a short read: the file shrank under us, so the bytes above
        // this block no longer line up with what the earlier ones assumed.
        if (filled < chunkSize) {
          break
        }
        bytesRead += filled
        scanEnd = position
        // Why search only the new block: carry is always the run before a newline,
        // so it holds none of its own.
        const firstNewline = buffer.indexOf(0x0a)
        const atStart = position === 0
        let completeRegion: Buffer
        if (atStart) {
          completeRegion =
            carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
          carryChunks = []
        } else if (firstNewline === -1) {
          completeRegion = EMPTY_TRANSCRIPT_REGION
          carryChunks.unshift(buffer)
        } else {
          const afterNewline = buffer.subarray(firstNewline + 1)
          completeRegion =
            carryChunks.length === 0 ? afterNewline : Buffer.concat([afterNewline, ...carryChunks])
          carryChunks = [buffer.subarray(0, firstNewline)]
        }
        if (completeRegion.length > 0) {
          const extracted = findLastExtractedTranscriptLineText(
            completeRegion.toString('utf8'),
            extractLineText
          )
          if (extracted !== undefined) {
            return extracted
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

export function findLastExtractedTranscriptLineText(
  text: string,
  extractLineText: (line: string) => string | undefined
): string | undefined {
  let lineEnd = text.length

  while (lineEnd > 0) {
    const index = text.lastIndexOf('\n', lineEnd - 1)

    const line = text.slice(index + 1, lineEnd).trim()
    if (line.length > 0) {
      const extracted = extractLineText(line)
      if (extracted !== undefined) {
        return extracted
      }
    }
    lineEnd = index
  }

  return undefined
}
