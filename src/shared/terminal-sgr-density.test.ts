import { describe, expect, it } from 'vitest'
import { isDenseSgr } from './terminal-sgr-density'

describe('isDenseSgr', () => {
  it('returns false for plain text', () => {
    expect(isDenseSgr('hello world\r\n')).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(isDenseSgr('')).toBe(false)
  })

  it('returns true for character-level highlighting (~1 SGR/char)', () => {
    const perChar = Array.from({ length: 8 }, (_, i) => `\x1b[38;5;${i}mX\x1b[0m`).join('')
    expect(isDenseSgr(perChar)).toBe(true)
  })

  it('returns false for token/word-level styling (~1 SGR/10 chars)', () => {
    const tokenLevel = `\x1b[32m${'token text '.repeat(10)}\x1b[0m`
    expect(isDenseSgr(tokenLevel)).toBe(false)
  })

  it('returns false for TUI repaints (non-SGR CSI only)', () => {
    const tuiRedraw = '\x1b[H\x1b[2J\x1b[1;1Htitle\x1b[2;1Hbody\x1b[3;1Htail'
    expect(isDenseSgr(tuiRedraw)).toBe(false)
  })

  it('counts 256-color and truecolor SGR parameters as SGR', () => {
    const perChar = '\x1b[38;5;196mR\x1b[0m\x1b[38;2;1;2;3mG\x1b[0m'
    expect(isDenseSgr(perChar)).toBe(true)
  })

  it('uses one SGR per two characters as the inclusive threshold', () => {
    expect(isDenseSgr('\x1b[31mXY')).toBe(true)
    expect(isDenseSgr('\x1b[31mXYZ')).toBe(false)
  })
})
