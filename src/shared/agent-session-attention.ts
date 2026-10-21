// The identity and wording of one structured attention edge, shared by every surface that
// announces it: the desktop's banner and unread, and the execution host's own phone push.

import {
  agentSessionScopeKey,
  isAgentSessionExecutionLocation,
  type AgentSessionExecutionLocation
} from './agent-session-record'
import type { AgentJournalCursor } from './agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from './agent-session-wire'
import { AGENT_JOURNAL_TURN_OUTCOMES, type AgentJournalTurnOutcome } from './agent-turn-outcome'

/** What the host says needs the user: a settled request, or a prompt it raised. */
export type AgentSessionAttentionEdge = Extract<
  AgentSessionTurnCompletionEvent,
  { type: 'completion' | 'prompt' }
>

export type StructuredAttentionOrigin = {
  scope: AgentSessionExecutionLocation
  sessionId: string
  cause: { kind: 'prompt'; promptId: string } | { kind: 'completion'; requestId: string }
  journalCursor: AgentJournalCursor
}

export type StructuredAttentionRead = { sessionId: string; observedCursor: AgentJournalCursor }
export function isStructuredAttentionRead(value: unknown): value is StructuredAttentionRead {
  if (
    !value ||
    typeof value !== 'object' ||
    !('sessionId' in value) ||
    !('observedCursor' in value)
  ) {
    return false
  }
  return (
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    isAttentionCursor(value.observedCursor)
  )
}

function isAttentionCursor(value: unknown): value is AgentJournalCursor {
  return (
    !!value &&
    typeof value === 'object' &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    value.epoch.length > 0 &&
    'sequence' in value &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0
  )
}
export type StructuredAttentionState = {
  scope: AgentSessionExecutionLocation
  sessionId: string
  pendingPromptIds: readonly string[]
}

export function structuredAttentionOrigin(
  edge: AgentSessionAttentionEdge
): StructuredAttentionOrigin | undefined {
  const payload = edge.type === 'prompt' ? edge.prompt : edge.completion
  if (!payload.journalCursor) {
    return undefined
  }
  return {
    scope: payload.scope,
    sessionId: payload.sessionId,
    journalCursor: payload.journalCursor,
    cause:
      edge.type === 'prompt'
        ? { kind: 'prompt', promptId: edge.prompt.promptId }
        : { kind: 'completion', requestId: edge.completion.turnId }
  }
}

export function attentionOriginWasRead(
  origin: StructuredAttentionOrigin | undefined,
  read: StructuredAttentionRead
): boolean {
  return (
    origin !== undefined &&
    origin.sessionId === read.sessionId &&
    origin.journalCursor.epoch === read.observedCursor.epoch &&
    origin.journalCursor.sequence <= read.observedCursor.sequence
  )
}

export function isStructuredAttentionOrigin(value: unknown): value is StructuredAttentionOrigin {
  if (
    !value ||
    typeof value !== 'object' ||
    !('scope' in value) ||
    !('sessionId' in value) ||
    !('cause' in value) ||
    !('journalCursor' in value)
  ) {
    return false
  }
  const { cause, journalCursor } = value
  return (
    isAgentSessionExecutionLocation(value.scope) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    !!cause &&
    typeof cause === 'object' &&
    'kind' in cause &&
    ((cause.kind === 'prompt' && 'promptId' in cause && typeof cause.promptId === 'string') ||
      (cause.kind === 'completion' &&
        'requestId' in cause &&
        typeof cause.requestId === 'string')) &&
    isAttentionCursor(journalCursor)
  )
}

/** Every attention key this host can mint for one session starts with this: what acknowledging
 *  the session retires. */
export function agentSessionAttentionSubjectPrefix(
  scope: AgentSessionExecutionLocation,
  sessionId: string
): string {
  const parts = ['agent-attention', agentSessionScopeKey(scope), sessionId]
  return `${parts.map(encodeURIComponent).join(':')}:`
}

/** One edge's identity, shared by every surface that announces it: the desktop banner, the host's
 *  mobile push and their retirement all use it, and delivery dedupes on it rather than a time window. */
export function agentSessionAttentionKey(edge: AgentSessionAttentionEdge): string {
  if (edge.type === 'prompt') {
    return agentSessionPromptAttentionKey(
      edge.prompt.scope,
      edge.prompt.sessionId,
      edge.prompt.promptId
    )
  }
  const { scope, sessionId, turnId } = edge.completion
  return `${agentSessionAttentionSubjectPrefix(scope, sessionId)}turn:${encodeURIComponent(turnId)}`
}

export function agentSessionPromptAttentionKey(
  scope: AgentSessionExecutionLocation,
  sessionId: string,
  promptId: string
): string {
  return `${agentSessionAttentionSubjectPrefix(scope, sessionId)}prompt:${encodeURIComponent(promptId)}`
}

/** What one edge tells the user, worded once for every surface; null when it tells nothing.
 *  `blocked` is the row's "needs input". */
export function agentSessionAttentionNews(
  edge: AgentSessionAttentionEdge
): { agentState: 'blocked' | 'done'; outcome?: AgentJournalTurnOutcome } | null {
  if (edge.type === 'prompt') {
    return { agentState: 'blocked' }
  }
  const { outcome, awaitingUser } = edge.completion
  // ABSENT OUTCOME IS UNKNOWN: a host that predates the field must not read as any verdict.
  if (!AGENT_JOURNAL_TURN_OUTCOMES.includes(outcome)) {
    return null
  }
  // A failure is news of its own even while a prompt waits; only a clean settle reads as the prompt.
  return {
    agentState: awaitingUser === true && outcome === 'success' ? 'blocked' : 'done',
    outcome
  }
}
