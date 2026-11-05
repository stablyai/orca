import { describe, expect, it } from 'vitest'
import { nativeChatForkSupport, nativeChatRowOffersFork } from './native-chat-fork-offer'
import type { NativeChatMessage } from './native-chat-types'

const reply: NativeChatMessage = {
  id: 'item-reply',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Done.' }],
  timestamp: 1,
  source: 'transcript',
  journalPosition: { sequence: 12, index: 0 }
}
const finished = { message: reply, inSubagentSection: false, turnWorking: false }
const checkpoint = {
  support: { kind: 'known', fork: 'checkpoint' },
  contextFloorSequence: 0
} as const
const tip = { support: { kind: 'known', fork: 'tip' }, contextFloorSequence: 0 } as const

describe('nativeChatRowOffersFork', () => {
  it('offers any finished root response of an agent that forks through any turn', () => {
    expect(nativeChatRowOffersFork({ ...finished, inLatestTurn: false }, checkpoint)).toBe(true)
  })

  it('offers only the newest turn of an agent that forks at its tip', () => {
    expect(nativeChatRowOffersFork({ ...finished, inLatestTurn: false }, tip)).toBe(false)
    expect(nativeChatRowOffersFork({ ...finished, inLatestTurn: true }, tip)).toBe(true)
  })

  it.each([
    ['a running turn', { ...finished, turnWorking: true }, checkpoint],
    ['a subagent section', { ...finished, inSubagentSection: true }, checkpoint],
    ['a subagent reply', { ...finished, message: { ...reply, agentId: 'child' } }, checkpoint],
    ['a row above a /clear', finished, { ...checkpoint, contextFloorSequence: 12 }],
    ['an agent without forks', finished, { support: { kind: 'none' }, contextFloorSequence: 0 }]
  ] as const)('hides it in %s', (_case, row, chat) => {
    expect(nativeChatRowOffersFork({ ...row, inLatestTurn: true }, chat)).toBe(false)
  })
})

describe('nativeChatForkSupport', () => {
  it('waits on an unanswered host or agent list, and hides once either says no', () => {
    const forks = { capabilities: { fork: 'checkpoint' as const } }
    expect(nativeChatForkSupport('unknown', forks)).toEqual({ kind: 'unknown' })
    expect(nativeChatForkSupport('supported', undefined)).toEqual({ kind: 'unknown' })
    expect(nativeChatForkSupport('unsupported', forks)).toEqual({ kind: 'none' })
    expect(nativeChatForkSupport('supported', { capabilities: {} })).toEqual({ kind: 'none' })
    expect(nativeChatForkSupport('supported', forks)).toEqual({
      kind: 'known',
      fork: 'checkpoint'
    })
  })
})
