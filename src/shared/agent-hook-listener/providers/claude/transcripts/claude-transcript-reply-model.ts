import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../../../agent-status/contracts/agent-status-field-normalization'
import { baseModelId } from '../../../../agent-session/options/model-catalog/model-id-label'
import { isRecord } from '../../../../agent-status/child-work/agent-status-child-work-value-guards'
import { parseHookBodyPayloadRecord } from '../../../grok-result-discovery'
import type { AgentHookEventPayload } from '../../../listener-event'
import { parseTranscriptRecord } from '../../../transcript-entry-text'
import { TRANSCRIPT_CHUNK_BYTES, TRANSCRIPT_MAX_SCAN_BYTES } from '../../../transcript-reader'
import type { AgentHookSource } from '../../../transport/agent-hook-relay'
import { scanFileRegionsBackwardAsync } from '../../../reverse-file-region-scan'

/** The model of the turn's reply, or null when the transcript ends on a user record (reply not written yet). */
type ReplyModelFind = { model: string | null }

const REPLY_MODEL_READ_ATTEMPTS = 5
const REPLY_MODEL_RETRY_MS = 50
// Skip parsing the big attachment and request records that sit between turns.
const LEAD_RECORD_TYPE = /"type"\s*:\s*"(?:assistant|user)"/

/** The transcript a lead Claude Stop's reply model is read from, after the Stop lands. */
export function claudeStopReplyModelTranscriptPath(
  source: AgentHookSource,
  event: Pick<AgentHookEventPayload, 'hookEventName' | 'toolAgentId'> | null,
  body: unknown
): string | undefined {
  if (source !== 'claude' || event?.hookEventName !== 'Stop' || event.toolAgentId !== undefined) {
    return undefined
  }
  const hookPayload = parseHookBodyPayloadRecord(body)
  const transcriptPath = hookPayload?.transcript_path
  return typeof transcriptPath === 'string' && transcriptPath && hookPayload?.agent_id === undefined
    ? transcriptPath
    : undefined
}

/** The reply's model when it names a different model than the row; replies drop the `[1m]` window
 *  suffix, which must not relabel an unchanged session. */
export function claudeReplyModelChange(
  current: string | undefined,
  reply: string
): string | undefined {
  return current !== undefined && baseModelId(current) === baseModelId(reply) ? undefined : reply
}

/** Stop can precede the reply's transcript write. */
export function claudeReplyModelRetryDelayMs(attempt: number): number | undefined {
  return attempt < REPLY_MODEL_READ_ATTEMPTS ? REPLY_MODEL_RETRY_MS : undefined
}

/** Claude hooks name the model only at SessionStart; each assistant record names the model that
 *  wrote it, so /model shows up here. undefined when nothing was found or the read failed. */
export async function readClaudeTranscriptReplyModelAsync(
  transcriptPath: string,
  keepReading: () => boolean,
  /** A retry passes the size its last scan saw: only lines reaching past it are searched again. */
  floor?: number,
  onError?: () => void
): Promise<string | null | undefined> {
  const found = await scanFileRegionsBackwardAsync(
    transcriptPath,
    { chunkBytes: TRANSCRIPT_CHUNK_BYTES, maxScanBytes: TRANSCRIPT_MAX_SCAN_BYTES, floor },
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
  const message = record?.message
  if (!record || record.isSidechain === true || !isRecord(message)) {
    return undefined
  }
  if (record.type === 'user') {
    // Tool results belong to the turn; any other user record (a prompt, /model output) starts a newer one.
    const content = message.content
    const toolResultsOnly =
      Array.isArray(content) &&
      content.length > 0 &&
      content.every((part) => isRecord(part) && part.type === 'tool_result')
    return toolResultsOnly ? undefined : { model: null }
  }
  if (record.type !== 'assistant') {
    return undefined
  }
  const model = normalizeOptionalField(message.model, AGENT_MODEL_MAX_LENGTH)
  // `<synthetic>` marks Claude Code's own error and repair text, not a model.
  return model && model !== '<synthetic>' ? { model } : undefined
}
