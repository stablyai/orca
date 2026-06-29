// Pure merge of live hook turn-state into a NativeChatSession status override.
// Kept separate from the React hook so the precedence rule (live 'working'
// surfaces before the transcript flushes the final assistant message, then is
// superseded once it lands) is unit-testable without IPC or the store.

import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { assembleNativeChatSession, type NativeChatSources } from './native-chat-session-assembler'
import type {
  AgentType,
  NativeChatSession,
  NativeChatSessionStatus
} from '../../../../shared/native-chat-types'

export type NativeChatLiveMergeInput = {
  sources: NativeChatSources
  sessionId: string | null
  agent: AgentType
  /** Live hook state for the pane, or null when no hook entry exists. */
  hookState: AgentStatusState | null
  /** True before the initial readSession resolves; forces 'loading'. */
  loading?: boolean
  /** Set when the initial read failed; forces 'error'. */
  error?: string
}

/**
 * Decide the session status given the merged transcript/append messages and the
 * live hook state. The transcript is the source of truth for content; the hook
 * only fills the gap while the agent is mid-turn.
 *
 * Precedence:
 *   - error / loading overrides win outright.
 *   - hook 'working' shows a live working indicator BEFORE the assistant turn
 *     lands in the transcript. Once the transcript's last message is an
 *     assistant reply (the turn flushed), 'working' is no longer asserted and
 *     the derived 'ready' status from the assembler stands.
 */
export function mergeNativeChatLiveSession(input: NativeChatLiveMergeInput): NativeChatSession {
  const { sources, sessionId, agent, hookState, loading, error } = input
  if (error) {
    return assembleNativeChatSession({ sources, sessionId, agent, status: 'error', error })
  }
  if (loading) {
    return assembleNativeChatSession({ sources, sessionId, agent, status: 'loading' })
  }

  const status = liveStatusOverride(sources, hookState)
  return assembleNativeChatSession({
    sources,
    sessionId,
    agent,
    ...(status ? { status } : {})
  })
}

function liveStatusOverride(
  sources: NativeChatSources,
  hookState: AgentStatusState | null
): NativeChatSessionStatus | undefined {
  // Only 'working' drives a live override; blocked/waiting/done leave the
  // derived (ready/empty) status alone so completed turns render normally.
  if (hookState !== 'working') {
    return undefined
  }
  // If the transcript has already flushed the in-flight assistant reply, the
  // turn is effectively visible — don't keep asserting 'working' on top of it.
  if (lastMessageIsFreshAssistant(sources)) {
    return undefined
  }
  return 'working'
}

function lastMessageIsFreshAssistant(sources: NativeChatSources): boolean {
  const transcript = sources.transcript ?? []
  const last = transcript.at(-1)
  return last?.role === 'assistant'
}
