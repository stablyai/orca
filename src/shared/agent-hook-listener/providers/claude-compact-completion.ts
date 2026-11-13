import type { AgentHookEventPayload } from '../listener-event'
// PreCompact alone also occurs on aborted compact, so it cannot mark working (STA-2915/STA-4613). Only manual PostCompact clears the pane; auto resumes a turn that emits Stop.

import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../agent-session/lifecycle/agent-session-resume'
import type { AgentHookSource } from '../transport/agent-hook-relay'

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

export function readLocalClaudeCompactTrigger(
  source: AgentHookSource,
  eventName: unknown,
  hookPayloadRecord: Record<string, unknown>
): { trigger: 'manual' | 'auto' | undefined } | null {
  const compactTrigger =
    source === 'claude' &&
    (eventName === 'PreCompact' || eventName === 'PostCompact') &&
    (hookPayloadRecord.trigger === 'manual' || hookPayloadRecord.trigger === 'auto')
      ? hookPayloadRecord.trigger
      : undefined
  // Reject malformed Claude compacts without suppressing other providers' normalizers.
  if (
    source === 'claude' &&
    (eventName === 'PreCompact' || eventName === 'PostCompact') &&
    compactTrigger === undefined
  ) {
    return null
  }
  return { trigger: compactTrigger }
}

export function retainClaudeCompactPrompt<T extends AgentHookEventPayload['payload']>(
  source: AgentHookSource | undefined,
  compactTrigger: 'manual' | 'auto' | undefined,
  acceptedCompactCompletion: boolean,
  normalizedPayload: T,
  previousPrompt: string | undefined
): T {
  if (
    source === 'claude' &&
    (compactTrigger !== undefined || acceptedCompactCompletion) &&
    normalizedPayload.prompt.length === 0 &&
    previousPrompt
  ) {
    normalizedPayload = { ...normalizedPayload, prompt: previousPrompt }
  }
  return normalizedPayload
}

export function reconcileRemoteClaudeCompactCompletion({
  source,
  hookEventName,
  compactTrigger,
  providerPromptId,
  paneKey,
  trimmedConnectionId,
  providerSession,
  previousStatus,
  normalizedPayload,
  consumed
}: {
  source: AgentHookSource | undefined
  hookEventName?: string
  compactTrigger?: 'manual' | 'auto'
  providerPromptId?: string
  paneKey: string
  trimmedConnectionId: string | null
  providerSession?: AgentProviderSessionMetadata
  previousStatus?: ClaudeCompactCompletionOwner & { payload: { prompt: string } }
  normalizedPayload: AgentHookEventPayload['payload']
  consumed: Parameters<typeof isClaudeCompactCompletionConsumed>[0]
}): { payload: AgentHookEventPayload['payload']; acceptedCompactCompletion: boolean } | null {
  let acceptedCompactCompletion = false
  if (hookEventName === 'PreCompact' || hookEventName === 'PostCompact') {
    // PreCompact alone proves no completed compact, including on older peers.
    if (hookEventName === 'PreCompact' || source !== 'claude') {
      return null
    }
    // Older relays omit the trigger; their state supplies it without bypassing ownership.
    const effectiveTrigger = resolveLegacyCompactTrigger(compactTrigger, normalizedPayload.state)
    // Older relays map auto-compaction to working; it resumes the existing turn and must not mint new work.
    if (effectiveTrigger !== 'manual' || normalizedPayload.agentType !== source) {
      return null
    }
    if (
      isClaudeCompactCompletionConsumed(consumed, paneKey, providerPromptId) ||
      !canAcceptClaudeCompactCompletion(previousStatus, {
        source,
        connectionId: trimmedConnectionId,
        providerPromptId,
        providerSession
      })
    ) {
      return null
    }
    markClaudeCompactCompletionConsumed(consumed, paneKey, providerPromptId)
    // Older relays omit the boundary flag; stamp it so compact completion stays silent.
    if (normalizedPayload.sessionBoundary !== true) {
      normalizedPayload = { ...normalizedPayload, sessionBoundary: true }
    }
    acceptedCompactCompletion = true
  }
  normalizedPayload = retainClaudeCompactPrompt(
    source,
    compactTrigger,
    acceptedCompactCompletion,
    normalizedPayload,
    previousStatus?.payload.prompt
  )
  return { payload: normalizedPayload, acceptedCompactCompletion }
}
