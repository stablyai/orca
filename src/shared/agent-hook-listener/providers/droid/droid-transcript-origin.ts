import { readPathFromKeys } from '../../../agent-session/lifecycle/agent-session-resume'
import { readFirstTranscriptRecord } from '../../transcript-reader'

/** The caller a Droid sub-session names in its transcript's first record; mission workers' hooks omit it. */
export function readDroidTranscriptCallingSessionId(
  hookPayload: Record<string, unknown>
): string | undefined {
  const transcriptPath = readPathFromKeys(hookPayload, ['transcriptPath', 'transcript_path'])
  const origin = transcriptPath ? readFirstTranscriptRecord(transcriptPath) : undefined
  return typeof origin === 'object' &&
    origin !== null &&
    'callingSessionId' in origin &&
    typeof origin.callingSessionId === 'string' &&
    origin.callingSessionId.length > 0
    ? origin.callingSessionId
    : undefined
}
