// Each chat's sends the host has not answered yet, in memory only: what the sender keeps and the
// chat's view reads.

import type { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'

export type StructuredAgentSessionPendingSend = {
  clientMessageId: string
  sessionId: string
  body: ReturnType<typeof structuredAgentSessionSendBody>
  previewUris: readonly string[]
  queuedAt: number
  delivery?: 'queue-if-active'
  /**
   * `sending`: on its way, its one request out or about to be; the chat takes no other send meanwhile.
   * `recorded`: the host holds it; an open chat draws it until the host's row or card arrives.
   */
  phase: 'sending' | 'recorded'
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

/** What the chat's view reads: its pending sends and the line saying why one came back. */
export function getStructuredAgentSessionPendingSends(
  sessionId: string
): readonly StructuredAgentSessionPendingSend[] {
  return sessions.get(sessionId)?.entries ?? EMPTY_STRUCTURED_AGENT_SESSION_SENDS
}

/** A view of this chat is mounted, so something draws its sends. */
export function structuredAgentSessionSendsWatched(sessionId: string): boolean {
  return (sessions.get(sessionId)?.listeners.size ?? 0) > 0
}

/** A send of this chat is out and not yet settled, or a write holds sends: the chat takes none. */
export function structuredAgentSessionSendOut(sessionId: string): boolean {
  return (
    structuredAgentSessionSendsHeld(sessionId) ||
    getStructuredAgentSessionPendingSends(sessionId).some((entry) => entry.phase === 'sending')
  )
}

export function structuredAgentSessionSendsHeld(sessionId: string): boolean {
  return (sessions.get(sessionId)?.holds ?? 0) > 0
}

/** Keeps every send of the chat out until the returned release runs (once). */
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

/** Says once, on the chat's line, why text came back to its composer. */
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
