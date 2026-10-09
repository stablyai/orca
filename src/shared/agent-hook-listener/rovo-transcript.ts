import { readFileSync, statSync } from 'node:fs'

import { parseAgentHookJson } from './request-body'
import { TRANSCRIPT_MAX_SCAN_BYTES } from './transcript-reader'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readResponseText(message: Record<string, unknown>): string | undefined {
  if (message.kind !== 'response' || !Array.isArray(message.parts)) {
    return undefined
  }
  const text = message.parts
    .flatMap((part) =>
      isRecord(part) && part.part_kind === 'text' && typeof part.content === 'string'
        ? [part.content]
        : []
    )
    .join('')
    .trim()
  return text.length > 0 ? text : undefined
}

/** Last assistant reply from Rovo's pydantic-ai `{message_history:[...]}` transcript. */
export function readLastRovoAssistantText(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  try {
    // Why: one JSON document (not JSONL), so it cannot be tail-scanned; cap like other readers.
    if (statSync(transcriptPath).size > TRANSCRIPT_MAX_SCAN_BYTES) {
      return undefined
    }
    const parsed: unknown = parseAgentHookJson(readFileSync(transcriptPath, 'utf8'))
    const history = isRecord(parsed) ? parsed.message_history : undefined
    if (!Array.isArray(history)) {
      return undefined
    }
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index]
      if (isRecord(entry) && entry.kind === 'request') {
        // Why: a newer user request means the turn ended before any reply text.
        return undefined
      }
      const text = isRecord(entry) ? readResponseText(entry) : undefined
      if (text) {
        return text
      }
    }
  } catch {
    // Why: Rovo deletes the temp transcript after hooks run; a vanished file is normal.
  }
  return undefined
}
