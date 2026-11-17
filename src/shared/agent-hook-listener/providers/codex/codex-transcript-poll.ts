import { record } from './codex-rollout-jsonl-cursor'
import {
  applyPendingCodexSubagentIdentities,
  hasPendingCodexSubagentIdentity,
  readPendingCodexSubagentIdentities,
  type CodexSubagentRoster
} from './codex-subagent-roster'
import {
  applyCodexSubagentTranscriptReads,
  codexTranscriptTurnEnd,
  readCodexSubagentTranscript,
  type CodexSubagentTranscriptReads,
  type CodexSubagentTranscriptState
} from './codex-subagent-transcript'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { buildCodexChildDrivenStatusPayload } from './codex-events'
import { getOrCreateCodexSubagentRoster, markCodexLeadTurnInterrupted } from './codex-state'
import { polledCodexStopPayload } from './codex-ended-turn-event'

export type CodexTranscriptPollReads = {
  roster: CodexSubagentRoster
  transcript?: CodexSubagentTranscriptState
  transcriptReads?: CodexSubagentTranscriptReads
  identities: Awaited<ReturnType<typeof readPendingCodexSubagentIdentities>>
}

/** Reads the pane's rollouts off the main thread; slow opens (Windows on-access scans) must never block it. */
export async function readCodexTranscriptPoll(
  state: HookListenerState,
  paneKey: string
): Promise<CodexTranscriptPollReads> {
  const roster = getOrCreateCodexSubagentRoster(state, paneKey)
  const transcript = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  const transcriptReads = transcript?.parent.filePath
    ? await readCodexSubagentTranscript(transcript)
    : undefined
  return {
    roster,
    transcript,
    transcriptReads,
    identities: await readPendingCodexSubagentIdentities(roster)
  }
}

/** Apply polled rollout records without replaying starting hooks; replay ended root turns as Stops skipped for internal subagents. Callers apply only while `original` is still the pane's row. */
export function pollCodexTranscriptStatus(
  state: HookListenerState,
  original: AgentHookEventPayload,
  body: unknown,
  env: string,
  reads: CodexTranscriptPollReads
): AgentHookEventPayload | undefined {
  const roster = getOrCreateCodexSubagentRoster(state, original.paneKey)
  const transcript = state.codexSubagentTranscriptByPaneKey.get(original.paneKey)
  const applyIdentities = (): boolean =>
    reads.roster === roster && applyPendingCodexSubagentIdentities(roster, reads.identities)
  if (!transcript?.parent.filePath) {
    const named = applyIdentities()
    // Without a parent rollout, keep polling only while a child's own rollout still owes its name.
    const payload = named
      ? buildCodexChildDrivenStatusPayload(state, undefined, original.paneKey, {})
      : undefined
    if (payload) {
      return { ...original, hookEventName: undefined, payload }
    }
    return hasPendingCodexSubagentIdentity(roster) ? original : undefined
  }
  const reconciled =
    reads.transcript === transcript && reads.transcriptReads !== undefined
      ? applyCodexSubagentTranscriptReads(transcript, roster, reads.transcriptReads)
      : false
  const changed = applyIdentities() || reconciled
  const lead = state.codexLeadStateByPaneKey.get(original.paneKey)
  const interrupted = transcript.rootTurn.interrupted && lead?.state !== 'done'
  const envelope = record(body)
  if (
    !interrupted &&
    envelope &&
    lead?.turnId &&
    lead.state !== 'done' &&
    codexTranscriptTurnEnd(transcript, lead.turnId)
  ) {
    const stop = {
      ...envelope,
      hook_event_name: undefined,
      hookEventName: undefined,
      payload: polledCodexStopPayload({
        hook_event_name: 'Stop',
        ...(lead.sessionId ? { session_id: lead.sessionId } : {}),
        turn_id: lead.turnId,
        transcript_path: transcript.parent.filePath
      })
    }
    return normalizeHookPayload(state, 'codex', stop, env) ?? undefined
  }
  if (!changed && !interrupted) {
    return original
  }
  if (interrupted) {
    markCodexLeadTurnInterrupted(state, original.paneKey)
  }
  const payload = buildCodexChildDrivenStatusPayload(state, undefined, original.paneKey, {})
  // Why: only a replayed Stop may carry an event name; this row restates the last hook's.
  return payload ? { ...original, hookEventName: undefined, payload } : undefined
}
