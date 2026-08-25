import { closeSync, openSync, readSync, statSync } from 'node:fs'

import { extractAssistantTextFromLine } from './transcript-entry-text'

export const TRANSCRIPT_CHUNK_BYTES = 64 * 1024
export const TRANSCRIPT_MAX_SCAN_BYTES = 4 * 1024 * 1024
export const EMPTY_TRANSCRIPT_REGION = Buffer.alloc(0)
export function readLastAssistantFromTranscriptOnce(transcriptPath: string): string | undefined {
  return readLastTextFromTranscriptOnce(transcriptPath, extractAssistantTextFromLine)
}

export function readLastTextFromTranscriptOnce(
  transcriptPath: string,
  extractLineText: (line: string) => string | undefined
): string | undefined {
  try {
    const stats = statSync(transcriptPath)
    const size = stats.size
    if (size <= 0) {
      return undefined
    }
    const fd = openSync(transcriptPath, 'r')
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

  for (let index = text.length - 1; index >= -1; index--) {
    if (index >= 0 && text.charCodeAt(index) !== 10) {
      continue
    }

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
