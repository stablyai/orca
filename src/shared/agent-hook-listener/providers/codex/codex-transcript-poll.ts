import { RolloutReadBatch } from './codex-rollout-async-reads'
import { record, type JsonlCursor } from './codex-rollout-jsonl-format'
import {
  createPrefetchedRolloutReads,
  withPrefetchedRolloutReads
} from './codex-rollout-prefetch-scope'
import { hasPendingCodexSubagentIdentity, type CodexSubagentRoster } from './codex-subagent-roster'
import {
  applyPendingCodexSubagentIdentities,
  readPendingCodexSubagentIdentities,
  type CodexSubagentIdentityRead
} from './codex-subagent-identity-reads'
import {
  applyCodexSubagentTranscriptReads,
  readCodexSubagentTranscript,
  type CodexSubagentTranscriptReads
} from './codex-subagent-transcript-reads'
import {
  codexTranscriptTurnEnd,
  type CodexSubagentTranscriptState
} from './codex-subagent-transcript'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { buildCodexChildDrivenStatusPayload } from './codex-events'
import { getOrCreateCodexSubagentRoster, markCodexLeadTurnInterrupted } from './codex-state'

export type CodexTranscriptPollReads = {
  /** Holds the read buffers' share of the budget; callers release it once the reads are applied or dropped. */
  batch: RolloutReadBatch
  roster?: CodexSubagentRoster
  transcript?: CodexSubagentTranscriptState
  transcriptReads?: CodexSubagentTranscriptReads
  identities: CodexSubagentIdentityRead[]
}

export type CodexTranscriptPollOwner = JsonlCursor | CodexSubagentRoster | 'codex'

export function codexTranscriptPollOwner(
  state: HookListenerState,
  paneKey: string
): CodexTranscriptPollOwner {
  return (
    state.codexSubagentTranscriptByPaneKey.get(paneKey)?.parent ??
    state.codexSubagentRosterByPaneKey.get(paneKey) ??
    'codex'
  )
}

/** Reads the pane's rollouts off the main thread; slow opens (Windows on-access scans) must never block it. */
export async function readCodexTranscriptPoll(
  state: HookListenerState,
  paneKey: string,
  live: () => boolean = () => true,
  signal?: AbortSignal
): Promise<CodexTranscriptPollReads> {
  const roster = state.codexSubagentRosterByPaneKey.get(paneKey)
  const transcript = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  const parent = transcript?.parent
  // A replaced or cleared pane makes the rest of these reads unappliable; stop opening rollouts for it.
  const batch = new RolloutReadBatch(
    () =>
      live() &&
      state.codexSubagentRosterByPaneKey.get(paneKey) === roster &&
      state.codexSubagentTranscriptByPaneKey.get(paneKey) === transcript &&
      transcript?.parent === parent,
    signal
  )
  try {
    const transcriptReads = transcript?.parent.filePath
      ? await readCodexSubagentTranscript(transcript, batch)
      : undefined
    return {
      batch,
      roster,
      transcript,
      transcriptReads,
      identities: roster ? await readPendingCodexSubagentIdentities(roster, batch) : []
    }
  } catch (error) {
    // Callers release on success; a rejected read must not keep its share of the budget.
    batch.release()
    throw error
  }
}

/** A newer hook for the same session can apply the reads to its latest row. */
export async function withCodexTranscriptPoll<T>(
  state: HookListenerState,
  paneKey: string,
  signal: AbortSignal,
  currentOwner: () => T | undefined,
  apply: (owner: T, reads: CodexTranscriptPollReads) => void
): Promise<void> {
  const reads = await readCodexTranscriptPoll(
    state,
    paneKey,
    () => currentOwner() !== undefined,
    signal
  )
  try {
    const owner = signal.aborted ? undefined : currentOwner()
    if (owner !== undefined) {
      apply(owner, reads)
    }
  } finally {
    reads.batch.release()
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
      payload: {
        hook_event_name: 'Stop',
        ...(lead.sessionId ? { session_id: lead.sessionId } : {}),
        turn_id: lead.turnId,
        transcript_path: transcript.parent.filePath
      }
    }
    // The poll just read this rollout; its replayed Stop must not reopen it on the main thread.
    return (
      withPrefetchedRolloutReads(createPrefetchedRolloutReads(), () =>
        normalizeHookPayload(state, 'codex', stop, env)
      ) ?? undefined
    )
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
