import { expect, it } from 'vitest'
import { foldAgentSessionConversationNames } from './agent-session-conversation-names'

it('learns the agent and side-chat origin independently from later naming frames', () => {
  const initial = foldAgentSessionConversationNames(new Map(), {
    type: 'snapshot',
    sessions: [],
    conversationNames: [{ sessionId: 'child', conversationName: 'Child', sideChat: null }]
  })
  const identified = foldAgentSessionConversationNames(initial, {
    type: 'snapshot',
    sessions: [],
    conversationNames: [
      { sessionId: 'child', conversationName: 'Child', agent: 'codex', sideChat: null }
    ]
  })
  expect(identified.get('child')).toEqual({
    sessionId: 'child',
    conversationName: 'Child',
    agent: 'codex',
    sideChat: null
  })

  const forked = foldAgentSessionConversationNames(identified, {
    type: 'snapshot',
    sessions: [],
    conversationNames: [
      { sessionId: 'child', conversationName: 'Child', sideChat: { sourceSessionId: 'parent' } }
    ]
  })
  expect(forked.get('child')).toEqual({
    sessionId: 'child',
    conversationName: 'Child',
    agent: 'codex',
    sideChat: { sourceSessionId: 'parent' }
  })
})
