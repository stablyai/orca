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
  it.each([1_000, 10_000])(
    'keeps the map when an older host omits a known agent (%i saved names)',
    (count) => {
      const seeded = names(count)
      let current = seeded
      for (let i = 0; i < 20; i++) {
        current = foldAgentSessionConversationNames(current, {
          type: 'snapshot',
          sessions: [],
          conversationNames: [{ sessionId: 's0', conversationName: 'Chat 0' }]
        })
        current = foldAgentSessionConversationNames(current, {
          type: 'snapshot',
          sessions: [],
          conversationNames: [{ sessionId: 's0', conversationName: 'Chat 0', agent: 'codex' }]
        })
      }
      expect(current).toBe(seeded)
      expect(current.get('s0')?.agent).toBe('codex')
    }
  )

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
