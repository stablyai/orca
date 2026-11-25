import { parseAgentHookJson } from './request-body'
import {
  readLastAssistantFromTranscriptOnce,
  readLastTextFromTranscriptOnce,
  type AssistantTranscriptFormat
} from './transcript-reader'

export function extractAntigravityUserRequest(content: string): string | undefined {
  const opener = '<USER_REQUEST>'
  const startIndex = content.indexOf(opener)
  const bodyStartIndex = startIndex === -1 ? -1 : startIndex + opener.length
  const endIndex = bodyStartIndex === -1 ? -1 : content.indexOf('</USER_REQUEST>', bodyStartIndex)
  const text =
    bodyStartIndex === -1 || endIndex === -1 ? content : content.slice(bodyStartIndex, endIndex)
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function extractUserPromptTextFromLine(line: string): string | undefined {
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
  if (
    (record.source === 'USER_EXPLICIT' || record.source === 'USER') &&
    (record.type === 'USER_INPUT' || record.type === 'REQUEST') &&
    typeof record.content === 'string'
  ) {
    return extractAntigravityUserRequest(record.content)
  }
  return undefined
}

let skippedStopTranscripts: string[] | null = null

/**
 * Runs one synchronous normalize with the Stop-text transcript fallback skipped and returns the
 * transcripts it skipped, so a host on the event loop can read them asynchronously afterwards.
 */
export function withStopTranscriptReadsSkipped<T>(normalize: () => T): {
  value: T
  skipped: readonly string[]
} {
  const outer = skippedStopTranscripts
  const skipped: string[] = []
  skippedStopTranscripts = skipped
  try {
    return { value: normalize(), skipped }
  } finally {
    skippedStopTranscripts = outer
  }
}

/** Stop-text fallback when the hook carries none; skipped inside withStopTranscriptReadsSkipped. */
export function readLastAssistantFromTranscript(
  transcriptPath: unknown,
  format: AssistantTranscriptFormat = 'shared'
): string | undefined {
  if (skippedStopTranscripts && typeof transcriptPath === 'string' && transcriptPath.length > 0) {
    skippedStopTranscripts.push(transcriptPath)
    return undefined
  }
  return readLastAssistantFromTranscriptInline(transcriptPath, format)
}

/** Always reads now; for fallbacks whose order against other sources must not change. */
export function readLastAssistantFromTranscriptInline(
  transcriptPath: unknown,
  format: AssistantTranscriptFormat = 'shared'
): string | undefined {
  return typeof transcriptPath === 'string' && transcriptPath.length > 0
    ? readLastAssistantFromTranscriptOnce(transcriptPath, format)
    : undefined
}

export function readLastUserPromptFromTranscript(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  return readLastTextFromTranscriptOnce(transcriptPath, extractUserPromptTextFromLine)
}
