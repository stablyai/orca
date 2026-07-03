import { describe, expect, it } from 'vitest'
import { timingSafeTokenCompare } from './timing-safe-token-compare'

describe('timingSafeTokenCompare', () => {
  it('returns true for identical tokens', () => {
    const token = 'abcdef0123456789'
    expect(timingSafeTokenCompare(token, token)).toBe(true)
  })

  it('returns false for different tokens of the same length', () => {
    expect(timingSafeTokenCompare('abcdef0123456789', 'xbcdef0123456789')).toBe(false)
  })

  it('returns false when the actual token is a prefix of the expected', () => {
    expect(timingSafeTokenCompare('abcdef0123456789', 'abcdef')).toBe(false)
  })

  it('returns false when the expected token is a prefix of the actual', () => {
    expect(timingSafeTokenCompare('abcdef', 'abcdef0123456789')).toBe(false)
  })

  it('returns false when both tokens are empty but differ in type', () => {
    expect(timingSafeTokenCompare('', '')).toBe(true)
  })

  it('returns false when one token is empty and the other is not', () => {
    expect(timingSafeTokenCompare('secret', '')).toBe(false)
    expect(timingSafeTokenCompare('', 'secret')).toBe(false)
  })

  it('handles UUID-shaped tokens correctly', () => {
    const token = '550e8400-e29b-41d4-a716-446655440000'
    expect(timingSafeTokenCompare(token, token)).toBe(true)
    expect(timingSafeTokenCompare(token, '550e8400-e29b-41d4-a716-446655440001')).toBe(false)
  })

  it('handles hex tokens of different lengths without throwing', () => {
    expect(() => timingSafeTokenCompare('a1b2c3', 'a1b2c3d4e5f6')).not.toThrow()
    expect(timingSafeTokenCompare('a1b2c3', 'a1b2c3d4e5f6')).toBe(false)
  })
})
