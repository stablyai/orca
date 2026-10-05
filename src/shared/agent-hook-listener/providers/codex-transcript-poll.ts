import { reconcileCodexSubagentTranscript } from '../../codex-subagent-transcript'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { buildCodexChildDrivenStatusPayload } from './codex-events'
import { getOrCreateCodexSubagentRoster, markCodexLeadTurnInterrupted } from './codex-state'

/** Polling reads new host-owned records without replaying the hook that started the turn. */
export function pollCodexTranscriptStatus<T extends AgentHookEventPayload>(
  state: HookListenerState,
  original: T
): T | undefined {
  const transcript = state.codexSubagentTranscriptByPaneKey.get(original.paneKey)
  if (!transcript?.parent.filePath) {
    return undefined
  }
  const changed = reconcileCodexSubagentTranscript(
    transcript,
    getOrCreateCodexSubagentRoster(state, original.paneKey),
    transcript.parent.filePath
  )
  const interrupted =
    transcript.rootTurn.interrupted &&
    state.codexLeadStateByPaneKey.get(original.paneKey)?.state !== 'done'
  if (!changed && !interrupted) {
    return original
  }
  if (interrupted) {
    markCodexLeadTurnInterrupted(state, original.paneKey)
  }
  const payload = buildCodexChildDrivenStatusPayload(state, undefined, original.paneKey, {})
  return payload ? { ...original, payload } : undefined
}
