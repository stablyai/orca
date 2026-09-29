import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { nativeChatRowTurnKeys, nativeChatSelfAnchoredTurnRows } from './native-chat-turn-grouping'

function message(id: string, role: NativeChatMessage['role'] = 'assistant'): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text: id }], timestamp: null, source: 'transcript' }
}

describe('nativeChatRowTurnKeys', () => {
  it('keeps rows after a mid-turn send with the turn that produced them', () => {
    // The #23621 shape: B lands mid-turn, three tool rows follow, all one turn.
    const messages = [
      message('A', 'user'),
      message('t1'),
      message('B', 'user'),
      message('t2'),
      message('t3'),
      message('t4')
    ]
    const owned = new Map([
      ['A', 'A'],
      ['t1', 'A'],
      ['B', 'A'],
      ['t2', 'A'],
      ['t3', 'A'],
      ['t4', 'A']
    ])
    expect(nativeChatRowTurnKeys(messages, owned)).toEqual(['A', 'A', 'A', 'A', 'A', 'A'])
  })

  it('lets an unmapped user row key itself and unmapped rows inherit it', () => {
    // C is an optimistic echo the journal has not admitted yet: positional rules.
    const messages = [message('A', 'user'), message('t1'), message('C', 'user'), message('t2')]
    const owned = new Map([
      ['A', 'A'],
      ['t1', 'A']
    ])
    expect(nativeChatRowTurnKeys(messages, owned)).toEqual(['A', 'A', 'C', 'C'])
  })

  it('reproduces preceding-user grouping exactly when the host attributes nothing', () => {
    const messages = [
      message('lead'),
      message('A', 'user'),
      message('t1'),
      message('B', 'user'),
      message('t2')
    ]
    const positional = [undefined, 'A', 'A', 'B', 'B']
    expect(nativeChatRowTurnKeys(messages, null)).toEqual(positional)
    expect(nativeChatRowTurnKeys(messages, new Map())).toEqual(positional)
  })

  it('keys a provider-opened turn to a record no message carries', () => {
    const messages = [message('A', 'user'), message('t1'), message('t2')]
    const owned = new Map([
      ['A', 'A'],
      ['t1', 'wake-turn'],
      ['t2', 'wake-turn']
    ])
    expect(nativeChatRowTurnKeys(messages, owned)).toEqual(['A', 'wake-turn', 'wake-turn'])
  })
})

describe('nativeChatSelfAnchoredTurnRows', () => {
  it('anchors a turn with no user bubble at its first rendered row', () => {
    const messages = [message('A', 'user'), message('t1'), message('t2'), message('t3')]
    const turnKeys = ['A', 'A', 'wake-turn', 'wake-turn']
    expect(nativeChatSelfAnchoredTurnRows(messages, turnKeys)).toEqual(new Map([['wake-turn', 2]]))
  })

  it('never anchors a turn whose key is a rendered message', () => {
    const messages = [message('A', 'user'), message('t1')]
    expect(nativeChatSelfAnchoredTurnRows(messages, ['A', 'A']).size).toBe(0)
  })
})
