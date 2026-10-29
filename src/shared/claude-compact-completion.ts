// PreCompact alone also occurs on aborted compact, so it cannot mark working (STA-2915/STA-4613). Only manual PostCompact clears the pane; auto resumes a turn that emits Stop.

import { agentProviderSessionsEqual } from './agent-session-resume'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentHookSource } from './agent-hook-relay'

export type ClaudeCompactCompletionOwner = {
  source?: AgentHookSource
  connectionId: string | null
  providerSession?: AgentProviderSessionMetadata
  restoredUnconfirmed?: true
  payload: { agentType?: string }
}

export type ClaudeCompactCompletionIncoming = {
  source?: AgentHookSource
  connectionId: string | null
  providerPromptId?: string
  providerSession?: AgentProviderSessionMetadata
}

/** Reject completion without a prompt ID: ownership and duplicate suppression both require it. */
export function canAcceptClaudeCompactCompletion(
  previous: ClaudeCompactCompletionOwner | undefined,
  incoming: ClaudeCompactCompletionIncoming
): boolean {
  if (incoming.source !== 'claude' || incoming.providerPromptId === undefined) {
    return false
  }
  // Compact clears existing rows; never resurrect a retired pane. Hydrated stuck rows instead carry restoredUnconfirmed.
  if (previous === undefined) {
    return false
  }
  if (previous.source !== 'claude' || previous.payload.agentType !== 'claude') {
    return false
  }
  if (previous.restoredUnconfirmed) {
    // Hydrated connection IDs are stale; only a recorded provider session may contradict the live event.
    return (
      previous.providerSession === undefined ||
      agentProviderSessionsEqual('claude', previous.providerSession, incoming.providerSession)
    )
  }
  return (
    previous.connectionId === incoming.connectionId &&
    agentProviderSessionsEqual('claude', previous.providerSession, incoming.providerSession)
  )
}

/** Remember applied compact completions so relay duplicates cannot refresh rows repeatedly. */
export function isClaudeCompactCompletionConsumed(
  consumedByPaneKey: Map<string, string>,
  paneKey: string,
  providerPromptId: string | undefined
): boolean {
  return providerPromptId !== undefined && consumedByPaneKey.get(paneKey) === providerPromptId
}

export function markClaudeCompactCompletionConsumed(
  consumedByPaneKey: Map<string, string>,
  paneKey: string,
  providerPromptId: string | undefined
): void {
  if (providerPromptId !== undefined) {
    consumedByPaneKey.set(paneKey, providerPromptId)
  }
}

/** Old relays strip compactTrigger but map manual to done and auto to working. Infer only the trigger from state; still enforce ownership. */
export function resolveLegacyCompactTrigger(
  compactTrigger: 'manual' | 'auto' | undefined,
  payloadState: string
): 'manual' | 'auto' | undefined {
  if (compactTrigger !== undefined) {
    return compactTrigger
  }
  return payloadState === 'done' ? 'manual' : undefined
}
