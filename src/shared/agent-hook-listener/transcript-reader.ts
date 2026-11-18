import { closeSync, openSync, readSync } from 'node:fs'
import { parseAgentHookJson } from './request-body'
import { extractAssistantTextFromLine } from './transcript-entry-text'
import { scanFileRegionsBackward } from './reverse-file-region-scan'

export const TRANSCRIPT_CHUNK_BYTES = 64 * 1024
export const TRANSCRIPT_MAX_SCAN_BYTES = 4 * 1024 * 1024
/** Read origin evidence from the first record only; later user records cannot establish root ownership. */
export function readFirstTranscriptRecord(transcriptPath: string): unknown {
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const chunks: Buffer[] = []
      let bytesRead = 0
      while (bytesRead < TRANSCRIPT_MAX_SCAN_BYTES) {
        const buffer = Buffer.alloc(
          Math.min(TRANSCRIPT_CHUNK_BYTES, TRANSCRIPT_MAX_SCAN_BYTES - bytesRead)
        )
        const count = readSync(fd, buffer, 0, buffer.length, bytesRead)
        if (count === 0) {
          return parseAgentHookJson(Buffer.concat(chunks).toString('utf8'))
        }
        bytesRead += count
        const chunk = buffer.subarray(0, count)
        const newline = chunk.indexOf(10)
        chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline))
        if (newline !== -1) {
          return parseAgentHookJson(Buffer.concat(chunks).toString('utf8'))
        }
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    // Missing, partial or unreadable origin is re-observed on the next ordinary hook.
  }
  return undefined
}

export function readLastAssistantFromTranscriptOnce(transcriptPath: string): string | undefined {
  return readLastTextFromTranscriptOnce(transcriptPath, extractAssistantTextFromLine)
}

export function readLastTextFromTranscriptOnce(
  transcriptPath: string,
  extractLineText: (line: string) => string | undefined
): string | undefined {
  return scanFileRegionsBackward(
    transcriptPath,
    { chunkBytes: TRANSCRIPT_CHUNK_BYTES, maxScanBytes: TRANSCRIPT_MAX_SCAN_BYTES },
    (region) => findLastExtractedTranscriptLineText(region.toString('utf8'), extractLineText)
  )
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
