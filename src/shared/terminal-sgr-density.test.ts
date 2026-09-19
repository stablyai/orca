import { describe, expect, it } from 'vitest'
import { isDenseSgr } from './terminal-sgr-density'

describe('isDenseSgr', () => {
  it('ignores plain text and non-SGR CSI output', () => {
    expect(isDenseSgr('hello world\r\n')).toBe(false)
    expect(isDenseSgr('\x1b[H\x1b[2Jtitle\x1b[1;1Hbody')).toBe(false)
  })

  it('recognizes character-level color output', () => {
    const data = Array.from({ length: 8 }, (_, index) => `\x1b[38;5;${index}mX\x1b[0m`).join('')
    expect(isDenseSgr(data)).toBe(true)
  })

  it('keeps token-level styling on the ordinary path', () => {
    expect(isDenseSgr(`\x1b[32m${'token '.repeat(10)}\x1b[0m`)).toBe(false)
  })

  it('uses an inclusive one-control-per-two-characters threshold', () => {
    expect(isDenseSgr('\x1b[31mXY')).toBe(true)
    expect(isDenseSgr('\x1b[31mXYZ')).toBe(false)
  })
})
