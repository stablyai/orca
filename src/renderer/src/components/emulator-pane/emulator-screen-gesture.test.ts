import { describe, expect, it } from 'vitest'
import {
  mapClientPointToSimulatorScreen,
  resolveEmulatorPointerAction
} from './emulator-screen-gesture'
import { resolveVisualStreamGeometry } from './emulator-device-frame-layout'

describe('emulator screen gestures', () => {
  it('inverse rotates fallback taps, drag phases and the home edge into raw panel space', () => {
    const displayRect = { left: 0, top: 0, width: 400, height: 200 }
    expect(
      resolveEmulatorPointerAction([{ clientX: 100, clientY: 160 }], displayRect, null, 8, 90)
    ).toEqual({
      kind: 'tap',
      point: { x: 0.8, y: 0.75 }
    })
    const action = resolveEmulatorPointerAction(
      [
        { clientX: 100, clientY: 190 },
        { clientX: 120, clientY: 100 },
        { clientX: 140, clientY: 50 }
      ],
      displayRect,
      null,
      8,
      90
    )
    expect(action).toEqual({
      kind: 'gesture',
      points: [
        { x: 0.95, y: 0.75, type: 'begin', edge: 4 },
        { x: 0.5, y: 0.7, type: 'move', edge: 4 },
        { x: 0.25, y: 0.65, type: 'end', edge: 4 }
      ]
    })
  })

  it('maps the full landscape screen while the stream canvas shape settles', () => {
    const landscapeRect = {
      left: 0,
      top: 0,
      width: 400,
      height: 200
    }
    const stalePortraitStream = { width: 390, height: 844 }

    expect(
      mapClientPointToSimulatorScreen(
        { clientX: 380, clientY: 100 },
        landscapeRect,
        resolveVisualStreamGeometry(stalePortraitStream, 'landscape').size
      )
    ).toEqual({ x: 0.95, y: 0.5 })
  })
})
