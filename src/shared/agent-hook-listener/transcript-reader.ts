import { extractAssistantTextFromLine } from './transcript-entry-text'
import { scanFileRegionsBackward } from './reverse-file-region-scan'

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
