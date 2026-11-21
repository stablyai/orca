import { describe, expect, it } from 'vitest'
import {
  encodeWin32InputRecordForAltGr,
  encodeWin32InputRecordRelease,
  type Win32InputRecordKeyEvent
} from './terminal-win32-input-records'

function germanAltGrQ(type: string): Win32InputRecordKeyEvent {
  return {
    type,
    key: '@',
    code: 'KeyQ',
    keyCode: 81,
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    getModifierState: (key) => key === 'AltGraph'
  }
}

describe('encodeWin32InputRecordForAltGr', () => {
  it('encodes German AltGr+Q as @ key-down and key-up records', () => {
    expect(encodeWin32InputRecordForAltGr(germanAltGrQ('keydown'))).toBe('\x1b[81;16;64;1;9;1_')
    expect(encodeWin32InputRecordForAltGr(germanAltGrQ('keyup'))).toBe('\x1b[81;16;64;0;9;1_')
  })

  it('leaves keys without AltGr to xterm', () => {
    expect(
      encodeWin32InputRecordForAltGr({ ...germanAltGrQ('keydown'), key: 'q', altKey: false })
    ).toBeNull()
  })
})

describe('encodeWin32InputRecordRelease', () => {
  it('releases Q with no modifiers when AltGr was let go first', () => {
    expect(
      encodeWin32InputRecordRelease({
        ...germanAltGrQ('keyup'),
        key: 'q',
        ctrlKey: false,
        altKey: false,
        getModifierState: () => false
      })
    ).toBe('[81;16;113;0;0;1_')
  })
})
