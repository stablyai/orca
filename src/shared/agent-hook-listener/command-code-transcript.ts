import { createHash } from 'node:crypto'

import { parseAgentHookJson } from './request-body'
import { scanFileRegionsBackward } from './reverse-file-region-scan'
import { extractAssistantContentText } from './transcript-entry-text'
import {
  readLastTextFromTranscriptOnce,
  TRANSCRIPT_CHUNK_BYTES,
  TRANSCRIPT_MAX_SCAN_BYTES
} from './transcript-reader'

export function extractCommandCodeUserPromptFromLine(line: string): string | undefined {
  let entry: unknown
  try {
    entry = parseAgentHookJson(line)
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const record = entry as Record<string, unknown>
  return record.role === 'user' ? extractAssistantContentText(record.content) : undefined
}

export function hashInteractionKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

// Why byte offsets: the caller's interactionKey embeds the prompt's absolute
// position, so the backward scan has to report the same offset the old
// read-everything-then-take-the-last-match pass produced.
export function findLastCommandCodePromptInRegion(
  region: Buffer
): { prompt: string; byteOffset: number } | undefined {
  let lineEnd = region.length
  for (let index = region.length - 1; index >= -1; index--) {
    if (index >= 0 && region[index] !== 0x0a) {
      continue
    }
    const lineStart = index + 1
    if (lineEnd > lineStart) {
      const prompt = extractCommandCodeUserPromptFromLine(
        region.subarray(lineStart, lineEnd).toString('utf8').trim()
      )
      if (prompt !== undefined) {
        return { prompt, byteOffset: lineStart }
      }
    }
    lineEnd = index
  }
  return undefined
}

export function readLastCommandCodeUserPromptEntryFromTranscript(
  transcriptPath: unknown
): { text: string; interactionKey: string } | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  return scanFileRegionsBackward(
    transcriptPath,
    { chunkBytes: TRANSCRIPT_CHUNK_BYTES, maxScanBytes: TRANSCRIPT_MAX_SCAN_BYTES },
    (region, regionPosition) => {
      const found = findLastCommandCodePromptInRegion(region)
      return found
        ? {
            text: found.prompt,
            interactionKey: [
              'command-code-transcript',
              hashInteractionKeyPart(transcriptPath),
              String(regionPosition + found.byteOffset),
              hashInteractionKeyPart(found.prompt)
            ].join('-')
          }
        : undefined
    }
  )
}

export function extractCommandCodeAssistantTextFromLine(line: string): string | undefined {
  let entry: unknown
  try {
    entry = parseAgentHookJson(line)
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const record = entry as Record<string, unknown>
  if (record.role !== 'assistant') {
    return undefined
  }
  const content = record.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        (part as Record<string, unknown>).type === 'text' &&
        typeof (part as Record<string, unknown>).text === 'string' &&
        ((part as Record<string, unknown>).text as string).trim().length > 0
    ) as Record<string, unknown> | undefined
    if (typeof textPart?.text === 'string') {
      return textPart.text
    }
  }
  return extractAssistantContentText(content)
}

export function readLastCommandCodeAssistantFromTranscript(
  transcriptPath: unknown
): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  return readLastTextFromTranscriptOnce(transcriptPath, extractCommandCodeAssistantTextFromLine)
}
