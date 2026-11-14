import { describe, expect, it } from 'vitest'
import {
  terminalForkPointBefore,
  terminalForkReplyIds,
  terminalForkTurnEnd
} from './terminal-fork-point'

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
    const ended = [
      ...rows,
      { id: 'a2', role: 'assistant', source: 'transcript' },
      { id: 't2', role: 'tool', source: 'transcript' }
    ] as const
    expect([...terminalForkReplyIds(ended, false)]).toEqual(['a2', 'a1'])
    expect([...terminalForkReplyIds(ended, true)]).toEqual(['a1'])
  })
})
