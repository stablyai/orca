import { describe, expect, it } from 'vitest'
import { foldAgentSessionConversationNames } from './agent-session-conversation-names'

function names(count: number) {
  return foldAgentSessionConversationNames(new Map(), {
    type: 'snapshot',
    sessions: [],
    conversationNames: Array.from({ length: count }, (_, i) => ({
      sessionId: `s${i}`,
      conversationName: `Chat ${i}`,
      agent: 'codex'
    }))
  })
}

describe('foldAgentSessionConversationNames', () => {
  it('keeps the map when an older host omits a known agent', () => {
    const seeded = names(3)
    const older = foldAgentSessionConversationNames(seeded, {
      type: 'snapshot',
      sessions: [],
      conversationNames: [{ sessionId: 's0', conversationName: 'Chat 0' }]
    })
    expect(older).toBe(seeded)
    const current = foldAgentSessionConversationNames(older, {
      type: 'snapshot',
      sessions: [],
      conversationNames: [{ sessionId: 's0', conversationName: 'Chat 0', agent: 'codex' }]
    })
    expect(current).toBe(seeded)
    expect(current.get('s0')?.agent).toBe('codex')
  })

  it('still applies a rename from a note without an agent', () => {
    const renamed = foldAgentSessionConversationNames(names(3), {
      type: 'snapshot',
      sessions: [],
      conversationNames: [{ sessionId: 's1', conversationName: 'Renamed' }]
    })

    expect(renamed.get('s1')).toEqual({
      sessionId: 's1',
      conversationName: 'Renamed',
      agent: 'codex'
    })
  })
})
