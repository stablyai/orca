import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import type { AgentVerdictFields } from '../../../agent-status/lifecycle/agent-main-agent-verdict'
import { parseAgentHookJson } from '../../request-body'
import { scanFileRegionsBackwardAsync } from '../../reverse-file-region-scan'
import {
  findLastExtractedTranscriptLineText,
  TRANSCRIPT_CHUNK_BYTES
} from '../../transcript-reader'

export type DroidTurnVerdict = 'failure' | 'cancellation'

// Droid's `agent_turn_outcome` reasons for a turn that failed; others (completed, spec_handoff, newer arms) stay unlabelled.
const DROID_FAILURE_REASONS = new Set([
  'error',
  'model_usage_exhausted',
  'model_authentication_failed',
  'model_request_rejected',
  'model_provider_unreachable',
  'model_provider_unavailable',
  'model_rate_limited',
  'prompt_rejected'
])

export function droidVerdictFields(
  verdict: DroidTurnVerdict,
  stateStartedAt: number
): AgentVerdictFields {
  return {
    ...(verdict === 'cancellation' ? { interrupted: true } : {}),
    mainAgent: { state: 'done', outcome: verdict, stateStartedAt }
  }
}

/** The outcome reason, '' for a user record (a prompt or tool result), undefined for any other line;
 *  a turn's outcome follows all its user records, so one before it belongs to an earlier turn. */
function outcomeReasonOrTurnStart(line: string): string | undefined {
  let entry: unknown
  try {
    entry = parseAgentHookJson(line)
  } catch {
    return undefined
  }
  if (!isRecord(entry)) {
    return undefined
  }
  if (entry.type === 'agent_turn_outcome') {
    return typeof entry.reason === 'string' ? entry.reason : undefined
  }
  const message = entry.type === 'message' ? entry.message : undefined
  // Hook runs and UI-only notices are stored as user records but never start a turn.
  return isRecord(message) &&
    message.role === 'user' &&
    message.visibility !== 'user_only' &&
    message.hookEventName === undefined
    ? ''
    : undefined
}

/**
 * The current turn's verdict from the tail of a Droid transcript: undefined while it has no
 * `agent_turn_outcome` yet (Droid appends it just after Stop), null once one records no fault.
 */
export async function readDroidTurnVerdictAsync(
  transcriptPath: string,
  keepReading?: () => boolean,
  onError?: () => void
): Promise<DroidTurnVerdict | null | undefined> {
  // The record is appended last, so one chunk from EOF holds it if it exists.
  const reason = await scanFileRegionsBackwardAsync(
    transcriptPath,
    { chunkBytes: TRANSCRIPT_CHUNK_BYTES, maxScanBytes: TRANSCRIPT_CHUNK_BYTES },
    (region) =>
      findLastExtractedTranscriptLineText(region.toString('utf8'), outcomeReasonOrTurnStart),
    keepReading,
    onError
  )
  if (!reason) {
    return undefined
  }
  if (reason === 'cancelled') {
    return 'cancellation'
  }
  return DROID_FAILURE_REASONS.has(reason) ? 'failure' : null
}
