import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

// Enough for any run of /side chats in one pane; the oldest ended long ago.
const MAX_FORKS_PER_PANE = 16
// Codex's hidden temporary threads (tui/src/temporary_structured_request.rs) run hooks when managed config pins them on.
const CODEX_HIDDEN_THREAD_PROMPT_PREFIXES = [
  // tui/src/app/thread_title.rs
  'Generate a concise, single-line task title',
  // context-fragments/src/recap_prompt.rs
  'Write a brief catch-up for a user returning to this task.'
]

// A /side thread shares the pane/process but cannot change its status; identify it from SessionStart or the persisted pane thread.
// Persisted identity survives restart and does not depend on parsed rollout availability.
// Returns the event to apply: undefined drops a foreign thread's hook.
export function codexHookEventForEphemeralThread(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): unknown {
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId || readString(hookPayload, 'agent_id') || hookPayload.transcript_path !== null) {
    return eventName
  }
  const forks = state.codexEphemeralForkSessionsByPaneKey.get(paneKey) ?? []
  if (forks.includes(sessionId)) {
    return undefined
  }
  const recordFork = (): undefined => {
    state.codexEphemeralForkSessionsByPaneKey.set(
      paneKey,
      [...forks, sessionId].slice(-MAX_FORKS_PER_PANE)
    )
    return undefined
  }
  const source = eventName === 'SessionStart' ? readString(hookPayload, 'source') : undefined
  if (source === 'fork') {
    return recordFork()
  }
  const row = state.lastStatusByPaneKey.get(paneKey)
  // Codex's hidden threads start like a new conversation; only their prompt tells them apart.
  if (source === 'startup' && rowHoldsOtherCodexThread(row, sessionId)) {
    state.codexHeldEphemeralStartByPaneKey.set(paneKey, sessionId)
    return undefined
  }
  if (state.codexHeldEphemeralStartByPaneKey.get(paneKey) === sessionId) {
    if (eventName !== 'UserPromptSubmit') {
      return undefined
    }
    state.codexHeldEphemeralStartByPaneKey.delete(paneKey)
    const prompt = readString(hookPayload, 'prompt')
    // Replay the held start so every receiver lets the new conversation take the pane.
    return CODEX_HIDDEN_THREAD_PROMPT_PREFIXES.some((prefix) => prompt?.startsWith(prefix))
      ? recordFork()
      : 'SessionStart'
  }
  if (source === 'startup' || source === 'clear') {
    return eventName
  }
  return rowHoldsOtherCodexThread(row, sessionId) ? undefined : eventName
}

/** Whether the pane's stored Codex row is a different thread, one with a rollout. */
export function rowHoldsOtherCodexThread(
  row: Pick<AgentHookEventPayload, 'payload' | 'providerSession'> | undefined,
  sessionId: string
): boolean {
  const thread = row?.payload.agentType === 'codex' ? row.providerSession : undefined
  return Boolean(thread?.transcriptPath && thread.id !== sessionId)
}
