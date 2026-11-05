import { describe, expect, it } from 'vitest'
import { encodeServeSimTouchFrame } from './emulator-touch-frame'

describe('encodeServeSimTouchFrame', () => {
  it('encodes serve-sim touch messages with the binary touch tag', () => {
    const frame = encodeServeSimTouchFrame({ type: 'move', x: 0.25, y: 0.75 })

    expect(frame[0]).toBe(0x03)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({
      type: 'move',
      x: 0.25,
      y: 0.75
    })
  })
})
