import { describe, expect, it } from 'vitest'
import {
  buildServeSimKeyboardFramesForKey,
  buildServeSimKeyboardFramesForText,
  encodeServeSimKeyboardFrame,
  SERVE_SIM_KEYBOARD_MESSAGE_TAG
} from './emulator-keyboard-frame'

describe('serve-sim keyboard frames', () => {
  it('builds shifted HID frames for uppercase text', () => {
    expect(buildServeSimKeyboardFramesForKey('A')).toEqual([
      { type: 'down', usage: 225 },
      { type: 'down', usage: 4 },
      { type: 'up', usage: 4 },
      { type: 'up', usage: 225 }
    ])
  })

  it('builds special editing key frames', () => {
    expect(buildServeSimKeyboardFramesForKey('Backspace')).toEqual([
      { type: 'down', usage: 42 },
      { type: 'up', usage: 42 }
    ])
  })

  it('preserves shift on named navigation keys', () => {
    expect(buildServeSimKeyboardFramesForKey('ArrowLeft', { shift: true })).toEqual([
      { type: 'down', usage: 225 },
      { type: 'down', usage: 80 },
      { type: 'up', usage: 80 },
      { type: 'up', usage: 225 }
    ])
    expect(buildServeSimKeyboardFramesForKey('Tab', { shift: true })).toEqual([
      { type: 'down', usage: 225 },
      { type: 'down', usage: 43 },
      { type: 'up', usage: 43 },
      { type: 'up', usage: 225 }
    ])
  })

  it('rejects unsupported non-US-keyboard text', () => {
    expect(buildServeSimKeyboardFramesForText('hello')).not.toBeNull()
    expect(buildServeSimKeyboardFramesForText('hello🙂')).toBeNull()
  })

  it('encodes serve-sim keyboard messages with the binary keyboard tag', () => {
    const frame = encodeServeSimKeyboardFrame({ type: 'down', usage: 4 })

    expect(frame[0]).toBe(SERVE_SIM_KEYBOARD_MESSAGE_TAG)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({
      type: 'down',
      usage: 4
    })
  })
})
