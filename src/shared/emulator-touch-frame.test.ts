import { describe, expect, it } from 'vitest'
import { encodeServeSimTouchFrame, SERVE_SIM_TOUCH_MESSAGE_TAG } from './emulator-touch-frame'

describe('encodeServeSimTouchFrame', () => {
  it('encodes serve-sim touch messages with the binary touch tag', () => {
    const frame = encodeServeSimTouchFrame({ type: 'move', x: 0.25, y: 0.75 })

    expect(frame[0]).toBe(SERVE_SIM_TOUCH_MESSAGE_TAG)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({
      type: 'move',
      x: 0.25,
      y: 0.75
    })
  })
})
