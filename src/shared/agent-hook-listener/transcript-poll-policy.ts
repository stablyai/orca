import type { AgentHookSource } from '../agent-hook-relay'
import { normalizeHookPayload } from '../agent-hook-listener'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import {
  pollClaudeAgentsKilled,
  syncClaudeAgentsKilledWatch
} from './providers/claude-agents-killed-transcript'
import { hasCodexTranscriptSubagents } from './providers/codex-state'
import { hasMuseSessionLog } from './providers/muse-events'

/** Whether a pane should be polled on a timer for state only its transcript shows. */
export function shouldPollHookTranscript(
  state: HookListenerState,
  source: AgentHookSource,
  event: AgentHookEventPayload
): boolean {
  if (source === 'codex') {
    return hasCodexTranscriptSubagents(state, event.paneKey)
  }
  if (source === 'claude') {
    return syncClaudeAgentsKilledWatch(state, event)
  }
  if (source === 'muse') {
    // Why: Muse's question tool fires no hook, so only its session log shows the wait and its answer.
    return event.payload.state !== 'done' && hasMuseSessionLog(state, event.paneKey)
  }
  return false
}

/** The row a due poll reads from, or undefined when the poll is stale. Claude's watch follows the
 *  pane's current row, which an inferred cancel replaces without rescheduling; a re-normalized
 *  hook body is only valid while its own row is current. */
export function transcriptPollAnchor<T extends AgentHookEventPayload>(
  source: AgentHookSource,
  current: T | undefined,
  original: T
): T | undefined {
  return source === 'claude' || current === original ? current : undefined
}

/** One due poll: the update to publish, undefined when the transcript added nothing, or null
 *  when the hook body no longer normalizes and polling should stop. */
export function hookTranscriptPollUpdate(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  anchor: AgentHookEventPayload,
  env: string
): AgentHookEventPayload | undefined | null {
  if (source === 'claude') {
    return pollClaudeAgentsKilled(state, anchor)
  }
  const polled = normalizeHookPayload(state, source, body, env)
  return polled && transcriptPollUpdate(source, anchor, polled)
}

/** Returns the poll result to publish, or undefined when it carries nothing new. */
export function transcriptPollUpdate<T extends AgentHookEventPayload>(
  source: AgentHookSource,
  original: T,
  polled: T
): T | undefined {
  if (source === 'muse') {
    const changed =
      polled.payload.state !== original.payload.state ||
      polled.payload.interactivePrompt !== original.payload.interactivePrompt
    // Why: a replayed UserPromptSubmit body is neither a newly sent prompt nor a turn boundary.
    return changed
      ? { ...polled, hasExplicitPrompt: undefined, hookEventName: undefined }
      : undefined
  }
  const subagentsChanged =
    JSON.stringify(polled.payload.subagents) !== JSON.stringify(original.payload.subagents)
  return subagentsChanged ? polled : undefined
}
