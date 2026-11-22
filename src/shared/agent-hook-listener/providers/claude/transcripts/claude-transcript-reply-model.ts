import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../../../agent-status/contracts/agent-status-field-normalization'
import { parseTranscriptRecord } from '../../../transcript-entry-text'
import { stopTranscriptReadsDeferred } from '../../../transcript-lines'
import { TRANSCRIPT_CHUNK_BYTES, TRANSCRIPT_MAX_SCAN_BYTES } from '../../../transcript-reader'
import {
  scanFileRegionsBackward,
  scanFileRegionsBackwardAsync
} from '../../../reverse-file-region-scan'

/** The model of the turn's reply, or null when the transcript ends on a user record (reply not written yet). */
type ReplyModelFind = { model: string | null }

const LIMITS = { chunkBytes: TRANSCRIPT_CHUNK_BYTES, maxScanBytes: TRANSCRIPT_MAX_SCAN_BYTES }
// Skip parsing the big attachment and request records that sit between turns.
const LEAD_RECORD_TYPE = /"type"\s*:\s*"(?:assistant|user)"/

/** Claude hooks name the model only at SessionStart; each assistant record names the model that wrote it, so /model shows up here. */
export function readClaudeTranscriptReplyModel(transcriptPath: string): string | null | undefined {
  return scanFileRegionsBackward(transcriptPath, LIMITS, findReplyModel)?.model
}

/** The async twin for event-loop callers; undefined when nothing was found or the read failed. */
export async function readClaudeTranscriptReplyModelAsync(
  transcriptPath: string,
  keepReading: () => boolean,
  floor: number | undefined,
  onError: () => void
): Promise<string | null | undefined> {
  const found = await scanFileRegionsBackwardAsync(
    transcriptPath,
    { ...LIMITS, floor },
    findReplyModel,
    keepReading,
    onError
  )
  return found?.model
}

function findReplyModel(region: Buffer): ReplyModelFind | undefined {
  const text = region.toString('utf8')
  let lineEnd = text.length
  while (lineEnd > 0) {
    const index = text.lastIndexOf('\n', lineEnd - 1)
    const line = text.slice(index + 1, lineEnd)
    lineEnd = index
    const found = LEAD_RECORD_TYPE.test(line) ? replyModelOfLine(line) : undefined
    if (found) {
      return found
    }
  }
  return undefined
}

function replyModelOfLine(line: string): ReplyModelFind | undefined {
  const record = parseTranscriptRecord(line.trim())
  if (!record || record.isSidechain === true) {
    return undefined
  }
  const message = record.message
  if (typeof message !== 'object' || message === null) {
    return undefined
  }
  if (record.type === 'user') {
    // Tool results belong to the turn; any other user record (a prompt, /model output) starts a newer one.
    const content = (message as Record<string, unknown>).content
    const toolResultsOnly =
      Array.isArray(content) &&
      content.length > 0 &&
      content.every((part) => (part as { type?: unknown } | null)?.type === 'tool_result')
    return toolResultsOnly ? undefined : { model: null }
  }
  if (record.type !== 'assistant') {
    return undefined
  }
  const model = normalizeOptionalField(
    (message as Record<string, unknown>).model,
    AGENT_MODEL_MAX_LENGTH
  )
  // `<synthetic>` marks Claude Code's own error and repair text, not a model.
  return model && model !== '<synthetic>' ? { model } : undefined
}

/** A lead Stop's reply model, read inline where the host doesn't defer Stop transcript reads. */
export function readClaudeStopReplyModel(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): string | undefined {
  const transcriptPath = hookPayload.transcript_path
  if (
    eventName !== 'Stop' ||
    typeof transcriptPath !== 'string' ||
    !transcriptPath ||
    hookPayload.agent_id !== undefined ||
    stopTranscriptReadsDeferred()
  ) {
    return undefined
  }
  return readClaudeTranscriptReplyModel(transcriptPath) ?? undefined
}
