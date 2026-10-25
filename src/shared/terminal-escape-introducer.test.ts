import { describe, expect, it } from 'vitest'
import {
  classifyTerminalEscapeIntroducer,
  type TerminalEscapeIntroducer
} from './terminal-escape-introducer'

/** Derive the oracle independently from VT500 byte ranges so implementation branch errors remain visible. */
function expected(code: number): TerminalEscapeIntroducer {
  if ('[' === String.fromCharCode(code)) {
    return 'csi'
  }
  if (']' === String.fromCharCode(code)) {
    return 'osc'
  }
  if ('PX^_'.includes(String.fromCharCode(code))) {
    return 'string'
  }
  if (String.fromCharCode(code) >= ' ' && String.fromCharCode(code) <= '/') {
    return 'intermediate'
  }
  if (code < 0x20 || code === 0x7f) {
    return 'execute'
  }
  return 'final'
}

describe('terminal escape introducer', () => {
  it('classifies every single-byte introducer the way the VT500 table does', () => {
    for (let code = 0; code <= 0xff; code += 1) {
      expect([code, classifyTerminalEscapeIntroducer(code)]).toEqual([code, expected(code)])
    }
  })

  it('opens ST-terminated strings for DCS, SOS, PM and APC only', () => {
    const strings = Array.from({ length: 0x100 }, (_, code) => code).filter(
      (code) => classifyTerminalEscapeIntroducer(code) === 'string'
    )
    expect(strings.map((code) => String.fromCharCode(code))).toEqual(['P', 'X', '^', '_'])
  })

  it('reads a missing byte (ESC at end of input) as a completed two-byte sequence', () => {
    // `charCodeAt` past the end is NaN; callers rely on that not becoming csi/osc/string.
    expect(classifyTerminalEscapeIntroducer(''.charCodeAt(0))).toBe('final')
  })
})
