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
  /** Epoch ms when the current hook state began, or null when unknown. Lets a
   *  stale 'working' self-heal once this turn's own assistant reply has landed. */
  stateStartedAt?: number | null
  /** True before the initial snapshot resolves; forces 'loading'. */
  loading?: boolean
  /** Set when the initial snapshot failed; forces 'error'. */
  error?: string
}

/**
 * Decide the session status given the merged transcript/append messages and the
 * live hook state. The transcript is the source of truth for content; the hook
 * only fills the gap while the agent is mid-turn.
 *
 * Precedence:
 *   - error / loading overrides win outright.
 *   - hook 'working' stays authoritative until the hook exits that state OR this
 *     turn's own assistant reply lands (a trailing reply newer than
 *     stateStartedAt); a trailing reply from an EARLIER turn does not suppress it.
 */
export function mergeNativeChatLiveSession(input: NativeChatLiveMergeInput): NativeChatSession {
  const { sources, sessionId, agent, hookState, stateStartedAt, loading, error } = input
  if (error) {
    return assembleNativeChatSession({ sources, sessionId, agent, status: 'error', error })
  }
  if (loading) {
    return assembleNativeChatSession({ sources, sessionId, agent, status: 'loading' })
  }

  const status = liveStatusOverride(hookState, sources, stateStartedAt)
  return assembleNativeChatSession({
    sources,
    sessionId,
    agent,
    ...(status ? { status } : {})
  })
}

function liveStatusOverride(
  hookState: AgentStatusState | null,
  sources: NativeChatSources,
  stateStartedAt: number | null | undefined
): NativeChatSessionStatus | undefined {
  // Only 'working' drives a live override; blocked/waiting/done leave the
  // derived (ready/empty) status alone so completed turns render normally.
  if (hookState !== 'working') {
    return undefined
  }
  // Self-heal a stale 'working' (dropped/late Stop hook): if this turn's own
  // assistant reply has already landed, the turn is effectively visible — stop
  // asserting 'working'. A trailing reply from a PRIOR turn (older than the
  // working turn's start) must not suppress it: the agent is working again.
  if (trailingAssistantPostDates(sources, stateStartedAt)) {
    return undefined
  }
  return 'working'
}

/** True when the transcript's last message is an assistant reply that landed at
 *  or after `stateStartedAt`. Unknown timings (no start, no message timestamp)
 *  return false so the caller keeps 'working' — the safe, non-regressing default. */
function trailingAssistantPostDates(
  sources: NativeChatSources,
  stateStartedAt: number | null | undefined
): boolean {
  if (stateStartedAt == null) {
    return false
  }
  const last = (sources.transcript ?? []).at(-1)
  if (last?.role !== 'assistant' || last.timestamp == null) {
    return false
  }
  return last.timestamp >= stateStartedAt
}
