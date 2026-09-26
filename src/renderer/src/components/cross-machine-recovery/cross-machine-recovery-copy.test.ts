import { describe, expect, it } from 'vitest'
import { refusedSessionsLabel, sessionCountLabel } from './cross-machine-recovery-copy'

describe('cross-machine recovery counts', () => {
  it.each([
    [1, '1 session'],
    [2, '2 sessions'],
    [0, '0 sessions']
  ])('labels %i sessions', (count, expected) => {
    expect(sessionCountLabel(count)).toBe(expected)
  })

  it('agrees the refused-session warning with its count', () => {
    expect(refusedSessionsLabel(1, 'a (x)')).toBe('1 session was left on the other computer: a (x)')
    expect(refusedSessionsLabel(2, 'a (x), b (y)')).toBe(
      '2 sessions were left on the other computer: a (x), b (y)'
    )
  })
})
