import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { nativeChatUserForkPoint } from './native-chat-fork-point'

function message(
  itemId: string,
  role: 'user' | 'assistant',
  sequence: number
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    observedAt: 0,
    sequence,
    body: { kind: 'message', role, blocks: [{ type: 'text', text: itemId }] }
  }
}

// Reply 1 was copied from the source chat; reply 3 is the fork's own, older than the newest reply 5.
const items: AgentJournalRenderItem[] = [
  message('reply-1', 'assistant', 1),
  {
    itemId: 'forked-from',
    revision: 1,
    observedAt: 0,
    sequence: 2,
    body: { kind: 'status', text: 'Forked', presentation: 'forked-from' }
  },
  message('ask-2', 'user', 3),
  message('reply-3', 'assistant', 4),
  message('ask-4', 'user', 5),
  message('reply-5', 'assistant', 6),
  message('ask-6', 'user', 7)
]
const chat = { items, contextFloor: undefined, epoch: null }

describe('nativeChatUserForkPoint', () => {
  it('keeps a tip-only agent with original support to the newest or inherited reply', () => {
    const support = { kind: 'known', fork: 'tip', inheritedOriginal: true } as const
    expect(nativeChatUserForkPoint({ ...chat, support }, 'ask-6')).toBe('reply-5')
    expect(nativeChatUserForkPoint({ ...chat, support }, 'ask-4')).toBeUndefined()
    expect(nativeChatUserForkPoint({ ...chat, support }, 'ask-2')).toBe('reply-1')
  })

  it('lets a checkpoint agent fork from any earlier reply', () => {
    const support = { kind: 'known', fork: 'checkpoint', inheritedOriginal: false } as const
    expect(nativeChatUserForkPoint({ ...chat, support }, 'ask-4')).toBe('reply-3')
  })
})
