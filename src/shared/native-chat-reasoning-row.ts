// The reasoning row, as desktop and mobile both draw it: whether it draws at all, and what its
// collapsed headline says. Read from host facts only — the row's start (`timestamp`), the end the
// host saw, and the host's live signal of which reasoning is open now — so every client tells the
// same story about one row.

import type { AgentSessionTurnActivity } from './agent-session-wire'
import { normalizeSubagentState } from './native-chat-subagent-summary'
import { formatNativeChatDuration } from './native-chat-turn-status'
import type { NativeChatMessage, NativeChatSubagentEntry } from './native-chat-types'

/** What the host's live reasoning gate answers for one activity, as a key that changes only when
 *  some answer does, so a client rebuilds the gate (and everything reading it) only then. Only the
 *  live turn's reasoning counts; '' when nothing is open, including from a host that sends no
 *  signal (an older one). */
export function nativeChatReasoningGateKey(
  activity: AgentSessionTurnActivity | null | undefined,
  liveTurnId: string | null
): string {
  const reasoning = liveTurnId && activity?.turnId === liveTurnId ? activity.reasoning : undefined
  return reasoning
    ? JSON.stringify([reasoning.session, [...(reasoning.subagents ?? [])].sort()])
    : ''
}

/** The gate when nothing is open, for callers without a host signal. */
export const NATIVE_CHAT_NOTHING_REASONING_OPEN = (_agentId?: string): boolean => false

/** The gate a key answers with: the session's own agent without `agentId`, else that subagent. The
 *  one rule every live "Thinking" reads. */
export function nativeChatReasoningGate(key: string): (agentId?: string) => boolean {
  if (!key) {
    return NATIVE_CHAT_NOTHING_REASONING_OPEN
  }
  const parsed: unknown = JSON.parse(key)
  const [session, ids] = Array.isArray(parsed) ? parsed : []
  const subagents = new Set(
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  )
  return (agentId) => (agentId === undefined ? session === true : subagents.has(agentId))
}

/** Whether a subagent shows "Thinking" now: the host reports its reasoning open and its roster entry
 *  says it works, so reasoning a host never saw end cannot outlive the agent. Its unfinished
 *  reasoning row hides exactly then, whichever turn its section sits in. */
export function isNativeChatSubagentThinking(
  isReasoningOpen: (agentId?: string) => boolean,
  agentId: string,
  entry: Pick<NativeChatSubagentEntry, 'state'> | undefined
): boolean {
  return (
    entry !== undefined &&
    normalizeSubagentState(entry.state) === 'working' &&
    isReasoningOpen(agentId)
  )
}

/** A reasoning row still being written while the host reports its reasoning open. It draws nothing
 *  until it ends: the live "Thinking" already says so, and one live indicator is enough. */
export function isNativeChatReasoningUnderway(
  message: Pick<NativeChatMessage, 'role' | 'state'>,
  reasoningOpen: boolean
): boolean {
  return message.role === 'reasoning' && message.state === 'running' && reasoningOpen
}

export type NativeChatReasoningHeadline =
  /** From a host that kept no lifecycle, or not ended yet: nothing is claimed. */
  | { kind: 'reasoning' }
  /** Ended, with no span the host saw. */
  | { kind: 'thought' }
  | { kind: 'thoughtFor'; duration: string }

export function nativeChatReasoningHeadline(
  message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>
): NativeChatReasoningHeadline {
  // A row still open draws when the host's live signal is absent or closed (an older host, a
  // dropped frame); it has not ended, so it does not read past tense.
  if (message.state !== 'completed') {
    return { kind: 'reasoning' }
  }
  if (message.completedAt === undefined || message.timestamp === null) {
    return { kind: 'thought' }
  }
  return {
    kind: 'thoughtFor',
    duration: formatNativeChatDuration(
      Math.max(1, (message.completedAt - message.timestamp) / 1000)
    )
  }
}

/** English copy for clients without a translation catalog; desktop translates the same three. */
const NATIVE_CHAT_REASONING_COPY = {
  reasoning: 'Reasoning',
  thought: 'Thought',
  thoughtFor: (duration: string) => `Thought for ${duration}`
} as const

export function nativeChatReasoningHeadlineText(headline: NativeChatReasoningHeadline): string {
  return headline.kind === 'thoughtFor'
    ? NATIVE_CHAT_REASONING_COPY.thoughtFor(headline.duration)
    : NATIVE_CHAT_REASONING_COPY[headline.kind]
}
