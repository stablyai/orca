import { parseAgentHookJson } from './request-body'
import {
  readLastAssistantFromTranscriptOnce,
  readLastTextFromTranscriptOnce
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

/** A textless Stop's reply, read off the event loop before normalize; no `text` when none was found. */
export type PrefetchedStopReply = { readonly transcriptPath?: string; readonly text?: string }

let prefetchedStopReply: PrefetchedStopReply | undefined

/** Runs one normalize on the event loop: its Stop-text fallback takes `reply` and never reads a transcript. */
export function withPrefetchedStopReply<T>(reply: PrefetchedStopReply, normalize: () => T): T {
  const outer = prefetchedStopReply
  prefetchedStopReply = reply
  try {
    return normalize()
  } finally {
    prefetchedStopReply = outer
  }
}

/** Stop-text fallback when the hook carries none; inside withPrefetchedStopReply it takes the prefetched reply. */
export function readLastAssistantFromTranscript(transcriptPath: unknown): string | undefined {
  if (prefetchedStopReply) {
    return transcriptPath === prefetchedStopReply.transcriptPath
      ? prefetchedStopReply.text
      : undefined
  }
  return readLastAssistantFromTranscriptInline(transcriptPath)
}

/** Always reads now; for fallbacks whose order against other sources must not change. */
export function readLastAssistantFromTranscriptInline(transcriptPath: unknown): string | undefined {
  return typeof transcriptPath === 'string' && transcriptPath.length > 0
    ? readLastAssistantFromTranscriptOnce(transcriptPath)
    : undefined
}

export function readLastUserPromptFromTranscript(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  return readLastTextFromTranscriptOnce(transcriptPath, extractUserPromptTextFromLine)
}
