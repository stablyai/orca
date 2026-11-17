import { codexTranscriptTurnEnd } from './codex-subagent-transcript'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'

/** Replay rollout-confirmed root ends as missing Stops, including /review; drop delayed hooks once the lead moved to another turn. */
export function codexHookEventForEndedTurn(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): unknown {
  const turnId = readString(hookPayload, 'turn_id')
  if (
    !turnId ||
    eventName === 'Stop' ||
    eventName === 'Interrupt' ||
    readString(hookPayload, 'agent_id')
  ) {
    return eventName
  }
  if (!codexTranscriptTurnEnd(state.codexSubagentTranscriptByPaneKey.get(paneKey), turnId)) {
    return eventName
  }
  const leadTurnId = state.codexLeadStateByPaneKey.get(paneKey)?.turnId
  return leadTurnId && leadTurnId !== turnId ? undefined : 'Stop'
}

const polledStopPayloads = new WeakSet<object>()

/** A Stop the transcript poll built from rollout records it just read; its normalization must not re-read the rollout on the main thread. */
export function polledCodexStopPayload<T extends object>(payload: T): T {
  polledStopPayloads.add(payload)
  return payload
}

export function isPolledCodexStopPayload(payload: object): boolean {
  return polledStopPayloads.has(payload)
}
