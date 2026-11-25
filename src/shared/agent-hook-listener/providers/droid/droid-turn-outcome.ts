import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import type { AgentVerdictFields } from '../../../agent-status/lifecycle/agent-main-agent-verdict'
import { parseHookBodyPayloadRecord } from '../../grok-result-discovery'
import type { AgentHookEventPayload } from '../../listener-event'
import { parseAgentHookJson } from '../../request-body'
import { scanFileRegionsBackwardAsync } from '../../reverse-file-region-scan'
import {
  findLastExtractedTranscriptLineText,
  TRANSCRIPT_CHUNK_BYTES
} from '../../transcript-reader'
import type { AgentHookSource } from '../../transport/agent-hook-relay'

export type DroidTurnVerdict = 'failure' | 'cancellation'

// Droid's own turn-status mapping of its known reasons; `completed` and `spec_handoff` are clean.
const DROID_CANCELLATION_REASONS: ReadonlySet<string> = new Set(['cancelled', 'process_exit'])
const DROID_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'error',
  'permission_rejected',
  'no_approver_available',
  'prompt_rejected',
  'completion_persistence_failed',
  'structured_output_missing',
  'structured_output_invalid',
  'structured_output_schema_invalid',
  'model_usage_exhausted',
  'model_authentication_failed',
  'model_request_rejected',
  'model_provider_unreachable',
  'model_provider_unavailable',
  'model_rate_limited'
])

// Droid appends the outcome only after every Stop hook exits and it has checked and persisted the
// session, so a slow sibling Stop hook or a large session delays it well past the reply flush.
const DROID_VERDICT_READ_ATTEMPTS = 10

/** The wait before the next verdict read once `attempt` found none, backing off to 1 s so the
 *  waits add up to at most about 5.5 s; undefined once the reads are spent. */
export function droidVerdictRetryDelayMs(attempt: number): number | undefined {
  return attempt < DROID_VERDICT_READ_ATTEMPTS
    ? Math.min(50 * 2 ** (attempt - 1), 1_000)
    : undefined
}

/** The transcript a Droid Stop's turn verdict lands in, whether or not the Stop carried its reply. */
export function droidStopTranscriptPath(
  source: AgentHookSource,
  event: Pick<AgentHookEventPayload, 'hookEventName'> | null,
  body: unknown
): string | undefined {
  if (source !== 'droid' || event?.hookEventName !== 'Stop') {
    return undefined
  }
  const transcriptPath = parseHookBodyPayloadRecord(body)?.transcript_path
  return typeof transcriptPath === 'string' && transcriptPath ? transcriptPath : undefined
}

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
  if (DROID_CANCELLATION_REASONS.has(reason)) {
    return 'cancellation'
  }
  // A reason Droid adds later stays plain done rather than guessing it is a failure.
  return DROID_FAILURE_REASONS.has(reason) ? 'failure' : null
}
