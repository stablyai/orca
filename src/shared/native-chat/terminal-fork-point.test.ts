import { describe, expect, it } from 'vitest'
import {
  terminalForkPointBefore,
  terminalForkReplyIds,
  terminalForkTurnEnd
} from './terminal-fork-point'
import type { NativeChatMessage } from './native-chat-types'

const rows = [
  { id: 'u1', role: 'user', source: 'transcript' },
  { id: 'a1', role: 'assistant', source: 'transcript' },
  { id: 't1', role: 'tool', source: 'transcript' },
  { id: 'u2', role: 'user', source: 'transcript' }
] as const

describe('terminal fork points', () => {
  it('copies a reply through the tool work that ends its turn', () => {
    expect(terminalForkTurnEnd(rows, 'a1')).toBe('t1')
  })
  it('forks from your message through the turn before it', () => {
    expect(terminalForkPointBefore(rows, 'u2')).toBe('t1')
    expect(terminalForkPointBefore(rows, 'u1')).toBeUndefined()
  })
  it('offers a reply whose turn ends in tool rows, mid-transcript and at the idle end', () => {
    const row = (id: string, role: NativeChatMessage['role'], text = '') => ({
      id,
      role,
      source: 'transcript' as const,
      timestamp: 1,
      blocks: text ? [{ type: 'text' as const, text }] : []
    })
    const ended: NativeChatMessage[] = [
      row('u1', 'user', 'go'),
      row('a1', 'assistant', 'Done.'),
      row('t1', 'tool'),
      row('u2', 'user', 'more'),
      row('a2', 'assistant', 'Also done.'),
      row('t2', 'tool'),
      row('s2', 'system', 'Stop hook feedback')
    ]
    expect([...terminalForkReplyIds(ended, false)]).toEqual(['a1', 'a2'])
    expect([...terminalForkReplyIds(ended, true)]).toEqual(['a1'])
  })
})
