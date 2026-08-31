import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'

import { parseAgentHookJson } from './request-body'
import { extractAssistantContentText } from './transcript-entry-text'
import {
  EMPTY_TRANSCRIPT_REGION,
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
  try {
    const stats = statSync(transcriptPath)
    const size = stats.size
    if (size <= 0) {
      return undefined
    }
    const fd = openSync(transcriptPath, 'r')
    try {
      // Why scan backward: the answer is the LAST user line, so walking up from
      // EOF returns on the first hit instead of parsing every line of a
      // multi-megabyte transcript on every hook event.
      // Why a chunk list: carry holds a partial line, and re-concatenating it per
      // block made one oversized line (a big tool result) cost O(line^2).
      let carryChunks: Buffer[] = []
      let bytesRead = 0
      let scanEnd = size
      while (scanEnd > 0 && bytesRead < TRANSCRIPT_MAX_SCAN_BYTES) {
        const chunkSize = Math.min(
          scanEnd,
          TRANSCRIPT_CHUNK_BYTES,
          TRANSCRIPT_MAX_SCAN_BYTES - bytesRead
        )
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
        // this block no longer line up and any stitched offset would be wrong.
        if (filled < chunkSize) {
          break
        }
        bytesRead += filled
        scanEnd = position
        // Why search only the new block: carry is always the run before a newline,
        // so it holds none of its own.
        const firstNewline = buffer.indexOf(0x0a)
        // Why only at a true file start: a scan that stops on the size cap must
        // discard its leading partial line, exactly as the capped read did.
        const atStart = position === 0
        let completeRegion: Buffer
        let regionPosition: number
        if (atStart) {
          completeRegion =
            carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
          regionPosition = position
          carryChunks = []
        } else if (firstNewline === -1) {
          completeRegion = EMPTY_TRANSCRIPT_REGION
          regionPosition = position
          carryChunks.unshift(buffer)
        } else {
          const afterNewline = buffer.subarray(firstNewline + 1)
          completeRegion =
            carryChunks.length === 0 ? afterNewline : Buffer.concat([afterNewline, ...carryChunks])
          regionPosition = position + firstNewline + 1
          carryChunks = [buffer.subarray(0, firstNewline)]
        }
        if (completeRegion.length > 0) {
          const found = findLastCommandCodePromptInRegion(completeRegion)
          if (found) {
            return {
              text: found.prompt,
              interactionKey: [
                'command-code-transcript',
                hashInteractionKeyPart(transcriptPath),
                String(regionPosition + found.byteOffset),
                hashInteractionKeyPart(found.prompt)
              ].join('-')
            }
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
