// Keep unanswered sends in memory only for the sender and mounted views.

import type { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'

export type StructuredAgentSessionPendingSend = {
  clientMessageId: string
  sessionId: string
  body: ReturnType<typeof structuredAgentSessionSendBody>
  previewUris: readonly string[]
  queuedAt: number
  delivery?: 'queue-if-active'
  selection?: Readonly<Record<string, string>>
  options?: Readonly<Record<string, string>>
  usageLimitContinuationOfTurnItemId?: string
  /** Sending blocks new sends; recorded releases the slot but retains its echo until host rows/cards arrive. */
  phase: 'sending' | 'recorded'
  /** A read past this acknowledgement supersedes the echo even when its row is off-page. */
  recordedCursor?: AgentJournalCursor
  /** Its request went out, so it may have reached the host. */
  issued: boolean
  /** A sender outside the chat keeps its own copy, so nothing goes to the chat's composer. */
  callerKeepsText?: true
  /** Made while the chat read Stopping: drawn after that turn until the host records it. */
  sentWhileStopping?: true
  /** Each image's SSH connection, in body order, so a returned image still opens remotely. */
  imageConnectionIds?: readonly (string | null)[]
}

type SessionSends = {
  entries: readonly StructuredAgentSessionPendingSend[]
  /** Why the last message went back to the composer; cleared by the next send. */
  notice: string | null
  /** Writes that keep every send out meanwhile: a /clear, whose host refuses them. */
  holds: number
  listeners: Set<() => void>
}

export const EMPTY_STRUCTURED_AGENT_SESSION_SENDS: readonly StructuredAgentSessionPendingSend[] = []
const sessions = new Map<string, SessionSends>()

function sessionSends(sessionId: string): SessionSends {
  let state = sessions.get(sessionId)
  if (!state) {
    state = {
      entries: EMPTY_STRUCTURED_AGENT_SESSION_SENDS,
      notice: null,
      holds: 0,
      listeners: new Set()
    }
    sessions.set(sessionId, state)
  }
  return state
}

export function publishStructuredAgentSessionSends(
  sessionId: string,
  change: Partial<Omit<SessionSends, 'listeners'>>
): void {
  const state = sessionSends(sessionId)
  Object.assign(state, change)
  for (const listener of state.listeners) {
    listener()
  }
}

export function updateStructuredAgentSessionPendingSend(
  sessionId: string,
  clientMessageId: string,
  change: Partial<StructuredAgentSessionPendingSend> | null
): void {
  const state = sessionSends(sessionId)
  publishStructuredAgentSessionSends(sessionId, {
    entries: state.entries.flatMap((entry) =>
      entry.clientMessageId !== clientMessageId ? [entry] : change ? [{ ...entry, ...change }] : []
    )
  })
}

export function findStructuredAgentSessionPendingSend(
  sessionId: string,
  clientMessageId: string
): StructuredAgentSessionPendingSend | undefined {
  return sessions.get(sessionId)?.entries.find((entry) => entry.clientMessageId === clientMessageId)
}

export function getStructuredAgentSessionPendingSends(
  sessionId: string
): readonly StructuredAgentSessionPendingSend[] {
  return sessions.get(sessionId)?.entries ?? EMPTY_STRUCTURED_AGENT_SESSION_SENDS
}

export function structuredAgentSessionSendsWatched(sessionId: string): boolean {
  return (sessions.get(sessionId)?.listeners.size ?? 0) > 0
}

export function structuredAgentSessionSendOut(sessionId: string): boolean {
  return (
    structuredAgentSessionSendsHeld(sessionId) ||
    getStructuredAgentSessionPendingSends(sessionId).some((entry) => entry.phase === 'sending')
  )
}

export function structuredAgentSessionSendsHeld(sessionId: string): boolean {
  return (sessions.get(sessionId)?.holds ?? 0) > 0
}

/** Block sends until the idempotent release runs. */
export function holdStructuredAgentSessionSends(sessionId: string): () => void {
  publishStructuredAgentSessionSends(sessionId, { holds: sessionSends(sessionId).holds + 1 })
  let held = true
  return () => {
    if (held) {
      held = false
      publishStructuredAgentSessionSends(sessionId, {
        holds: Math.max(0, sessionSends(sessionId).holds - 1)
      })
    }
  }
}

export function getStructuredAgentSessionSendNotice(sessionId: string): string | null {
  return sessions.get(sessionId)?.notice ?? null
}

export function setStructuredAgentSessionSendNotice(sessionId: string, notice: string): void {
  publishStructuredAgentSessionSends(sessionId, { notice })
}

export function subscribeToStructuredAgentSessionPendingSends(
  sessionId: string,
  listener: () => void
): () => void {
  const state = sessionSends(sessionId)
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

/** Forgets a chat's sends, keeping its listeners. */
export function clearStructuredAgentSessionPendingSends(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (state) {
    publishStructuredAgentSessionSends(sessionId, {
      entries: EMPTY_STRUCTURED_AGENT_SESSION_SENDS,
      notice: null
    })
    if (state.listeners.size === 0 && state.holds === 0) {
      sessions.delete(sessionId)
    }
  }
}

export function structuredAgentSessionsWithPendingSends(): string[] {
  return [...sessions.keys()]
}
