import { describe, expect, it } from 'vitest'
import {
  foldAgentSessionConversationNames,
  type AgentSessionConversationNames
} from './agent-session-conversation-names'
import type { AgentSessionStatusEvent } from './agent-session-wire'

const EMPTY: AgentSessionConversationNames = new Map()

function notes(...conversationNames: unknown[]): AgentSessionStatusEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: frames from a paired host are unchecked wire data.
  return { type: 'snapshot', sessions: [], conversationNames } as AgentSessionStatusEvent
}

function status(session: Record<string, unknown>): AgentSessionStatusEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the naming fields matter to this fold.
  return { type: 'status', session } as unknown as AgentSessionStatusEvent
}

describe('foldAgentSessionConversationNames fork provenance', () => {
  it('keeps the fork mark of an unnamed fork from a current host', () => {
    const names = foldAgentSessionConversationNames(
      EMPTY,
      status({ sessionId: 'fork', forkedFrom: { sessionId: 'source' } })
    )
    expect(names.get('fork')).toEqual({
      sessionId: 'fork',
      conversationName: null,
      forkedFrom: { sessionId: 'source' }
    })
  })

  it('clears the mark when a current host says the chat is not a fork', () => {
    const forked = foldAgentSessionConversationNames(
      EMPTY,
      notes({ sessionId: 'chat', conversationName: 'Plan', forkedFrom: { sessionId: 'source' } })
    )
    const plain = foldAgentSessionConversationNames(
      forked,
      notes({ sessionId: 'chat', conversationName: 'Plan', forkedFrom: null })
    )
    expect(plain.get('chat')?.forkedFrom).toBeNull()
  })

  it('shows an older host frame as that host would, with no fork data left behind', () => {
    const forked = foldAgentSessionConversationNames(
      EMPTY,
      notes({
        sessionId: 'chat',
        conversationName: 'Plan',
        conversationNameSource: 'user',
        forkedFrom: { sessionId: 'source', plainName: true }
      })
    )
    const old = foldAgentSessionConversationNames(
      forked,
      notes({ sessionId: 'chat', conversationName: 'Plan' })
    )
    expect(old.get('chat')).toEqual({ sessionId: 'chat', conversationName: 'Plan' })
  })

  it('ignores an older host status frame for an unnamed chat', () => {
    expect(foldAgentSessionConversationNames(EMPTY, status({ sessionId: 'chat' }))).toBe(EMPTY)
  })

  it('publishes a same-text rename the user made', () => {
    const orcaNamed = foldAgentSessionConversationNames(
      EMPTY,
      notes({ sessionId: 'chat', conversationName: 'Plan fork', forkedFrom: { sessionId: 's' } })
    )
    const userNamed = foldAgentSessionConversationNames(
      orcaNamed,
      notes({
        sessionId: 'chat',
        conversationName: 'Plan fork',
        conversationNameSource: 'user',
        forkedFrom: { sessionId: 's' }
      })
    )
    expect(userNamed).not.toBe(orcaNamed)
    expect(userNamed.get('chat')?.conversationNameSource).toBe('user')
  })

  it('keeps the same map when a frame repeats the naming state', () => {
    const frame = { sessionId: 'chat', conversationName: 'Plan', forkedFrom: { sessionId: 's' } }
    const names = foldAgentSessionConversationNames(EMPTY, notes(frame))
    expect(foldAgentSessionConversationNames(names, status({ ...frame, model: 'x' }))).toBe(names)
  })

  it('reads a malformed fork link as an older host frame', () => {
    const names = foldAgentSessionConversationNames(
      EMPTY,
      notes({ sessionId: 'chat', conversationName: 'Plan', forkedFrom: { sessionId: 7 } })
    )
    expect(names.get('chat')).toEqual({ sessionId: 'chat', conversationName: 'Plan' })
  })
})
