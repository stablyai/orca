import { describe, expect, it } from 'vitest'
import { isDenseTerminalSgr, stripTerminalSgr } from './terminal-sgr-load'

describe('dense terminal SGR classification', () => {
  it('classifies per-character styling', () => {
    const output = Array.from(
      { length: 64 },
      (_value, index) => `\x1b[38;5;${index}mX\x1b[0m`
    ).join('')

    expect(isDenseTerminalSgr(output)).toBe(true)
  })

  it('keeps token-level styling on the ordinary path', () => {
    const output = Array.from(
      { length: 64 },
      (_value, index) => `\x1b[38;5;${index}mten-character-token\x1b[0m`
    ).join('')

    expect(isDenseTerminalSgr(output)).toBe(false)
  })

  it('requires 32 sequences at one SGR per two text characters', () => {
    expect(isDenseTerminalSgr('\x1b[31mXY'.repeat(31))).toBe(false)
    expect(isDenseTerminalSgr('\x1b[31mXY'.repeat(32))).toBe(true)
    expect(isDenseTerminalSgr(`${'\x1b[31m'.repeat(32)}${'X'.repeat(65)}`)).toBe(false)
  })

  it('ignores non-SGR control sequences', () => {
    expect(isDenseTerminalSgr('\x1b[2K\x1b[H'.repeat(64))).toBe(false)
  })

  it('strips SGR while retaining text and non-SGR controls', () => {
    expect(stripTerminalSgr('\x1b[31mred\x1b[0m\x1b[6n')).toBe('\x18\x1b[0mred\x1b[6n\x18\x1b[0m')
  })

  it('retains OSC strings and printable echo bytes', () => {
    expect(stripTerminalSgr('\x1b[31mX\x1b]0;title\x07__ECHO__\x1b[0m')).toBe(
      '\x18\x1b[0mX\x1b]0;title\x07__ECHO__\x18\x1b[0m'
    )
  })

  it('cancels an incomplete CSI tail before retained echo bytes', () => {
    const stripped = stripTerminalSgr('\x1b[31mred\x1b[38;5')

    expect(`${stripped}__ECHO__`).toBe('\x18\x1b[0mred\x1b[38;5\x18\x1b[0m__ECHO__')
  })

  it('stops at an unterminated CSI tail', () => {
    const tail = `\x1b[${'1;'.repeat(64 * 1024)}`

    expect(isDenseTerminalSgr(tail)).toBe(false)
    expect(stripTerminalSgr(`\x1b[31mred${tail}`)).toBe(`\x18\x1b[0mred${tail}\x18\x1b[0m`)
  })
})
