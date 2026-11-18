import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { buildAntigravityFoldedStatusPayload } from './antigravity-events'

export function hasAntigravityPollWork(
  state: HookListenerState,
  event: AgentHookEventPayload
): boolean {
  return (
    Boolean(state.antigravityChildWorkByPaneKey.get(event.paneKey)?.rootBrainDir) &&
    event.payload.state !== 'done'
  )
}

/** Poll active Antigravity subagents and swarm workers when hooks are idle between coordinator turns. */
export function pollAntigravityTranscriptStatus(
  state: HookListenerState,
  original: AgentHookEventPayload
): AgentHookEventPayload | undefined {
  const paneState = state.antigravityChildWorkByPaneKey.get(original.paneKey)
  if (!paneState?.rootBrainDir) {
    return undefined
  }
  const payload = buildAntigravityFoldedStatusPayload(
    state,
    original.paneKey,
    paneState,
    Date.now()
  )
  if (!payload) {
    return undefined
  }
  if (payload.state === 'done' && paneState.leadState === 'done') {
    state.antigravityChildWorkByPaneKey.delete(original.paneKey)
  }
  return { ...original, hookEventName: undefined, payload }
}
