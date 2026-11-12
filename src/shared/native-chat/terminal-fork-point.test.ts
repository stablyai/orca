import { describe, expect, it } from 'vitest'
import { terminalForkPointBefore, terminalForkTurnEnd } from './terminal-fork-point'

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
})
