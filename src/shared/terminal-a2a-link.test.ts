import { describe, expect, it } from 'vitest'
import { parseTerminalIndex } from './terminal-a2a-link'

describe('terminal-a2a-link', () => {
  it('parses terminal targets with @, #, or bare numbers', () => {
    expect(parseTerminalIndex('@2')).toBe(2)
    expect(parseTerminalIndex('#5')).toBe(5)
    expect(parseTerminalIndex('8')).toBe(8)
    expect(parseTerminalIndex('@10')).toBe(10)
    expect(parseTerminalIndex('#100')).toBe(100)
  })

  it('returns undefined for non-numeric targets or empty input', () => {
    expect(parseTerminalIndex('')).toBeUndefined()
    expect(parseTerminalIndex(null)).toBeUndefined()
    expect(parseTerminalIndex(undefined)).toBeUndefined()
    expect(parseTerminalIndex('@worker-1')).toBeUndefined()
    expect(parseTerminalIndex('codex')).toBeUndefined()
    expect(parseTerminalIndex('@0')).toBeUndefined()
  })
})
