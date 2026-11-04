import type { AgentHookSource } from './transport/agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { hasCodexTranscriptSubagents } from './providers/codex-state'
import { hasMuseSessionLog } from './providers/muse-events'
import { mainAgentStatusEqual } from '../agent-status/lifecycle/main-agent-status'

export function shouldPollHookTranscript(
  state: HookListenerState,
  source: AgentHookSource,
  event: AgentHookEventPayload
): boolean {
  if (source === 'codex') {
    return (
      hasCodexTranscriptSubagents(state, event.paneKey) ||
      (state.codexLeadStateByPaneKey.get(event.paneKey)?.state !== 'done' &&
        Boolean(state.codexSubagentTranscriptByPaneKey.get(event.paneKey)?.parent.filePath))
    )
  }
  if (source === 'muse') {
    // Muse question waits/answers exist only in the session log.
    return event.payload.state !== 'done' && hasMuseSessionLog(state, event.paneKey)
  }
  return false
}

/** Child rollout discovery keeps its existing cadence; only a root-only pane can use one file watch. */
export function hookTranscriptWatchPath(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string
): string | undefined {
  return source === 'codex' && !hasCodexTranscriptSubagents(state, paneKey)
    ? state.codexSubagentTranscriptByPaneKey.get(paneKey)?.parent.filePath
    : undefined
}

export function transcriptPollUpdate<T extends AgentHookEventPayload>(
  source: AgentHookSource,
  original: T,
  polled: T
): T | undefined {
  if (original === polled) {
    return undefined
  }
  if (source === 'muse') {
    const changed =
      polled.payload.state !== original.payload.state ||
      polled.payload.interactivePrompt !== original.payload.interactivePrompt
    // Replayed prompt bodies cannot create new prompt or turn boundaries.
    return changed
      ? { ...polled, hasExplicitPrompt: undefined, hookEventName: undefined }
      : undefined
  }
  const subagentsChanged =
    JSON.stringify(polled.payload.subagents) !== JSON.stringify(original.payload.subagents)
  const leadChanged = !mainAgentStatusEqual(polled.payload.mainAgent, original.payload.mainAgent)
  if (!subagentsChanged && !leadChanged) {
    return undefined
  }
  // The source folds the verified root end before removing a success-shaped public label.
  const endedRoot = polled.hookEventName === 'Stop' && original.payload.mainAgent?.state !== 'done'
  const replayedStop = endedRoot && polled.payload.mainAgent?.outcome !== 'failure'
  return {
    ...polled,
    ...(endedRoot && source === 'codex' ? { transcriptTurnEnd: true as const } : {}),
    hasExplicitPrompt: undefined,
    hookEventName: replayedStop ? 'Stop' : undefined
  }
}
