import { describe, expect, it } from 'vitest'
import {
  buildWheelGesturePoints,
  mapClientPointToSimulatorScreen,
  resolveEmulatorWheelDelta,
  resolveEmulatorPointerAction
} from './emulator-screen-gesture'
import { resolveVisualStreamGeometry } from './emulator-device-frame-layout'

const rect = {
  left: 10,
  top: 20,
  width: 200,
  height: 400
}

describe('emulator screen gestures', () => {
  it('maps client coordinates into normalized simulator coordinates', () => {
    expect(mapClientPointToSimulatorScreen({ clientX: 110, clientY: 220 }, rect, null)).toEqual({
      x: 0.5,
      y: 0.5
    })
  })

  it('keeps small movement as a tap', () => {
    const action = resolveEmulatorPointerAction(
      [
        { clientX: 100, clientY: 200 },
        { clientX: 103, clientY: 204 }
      ],
      rect,
      null
    )

    expect(action).toEqual({
      kind: 'tap',
      point: { x: 0.465, y: 0.46 }
    })
  })

  it('turns a drag into a begin/move/end gesture sequence', () => {
    const action = resolveEmulatorPointerAction(
      [
        { clientX: 110, clientY: 320 },
        { clientX: 110, clientY: 260 },
        { clientX: 110, clientY: 180 }
      ],
      rect,
      null
    )

    expect(action).toEqual({
      kind: 'gesture',
      points: [
        { type: 'begin', x: 0.5, y: 0.75 },
        { type: 'move', x: 0.5, y: 0.6 },
        { type: 'end', x: 0.5, y: 0.4 }
      ]
    })
  })

  it('marks drags that start at the home indicator as bottom-edge gestures', () => {
    const action = resolveEmulatorPointerAction(
      [
        { clientX: 110, clientY: 396 },
        { clientX: 110, clientY: 260 },
        { clientX: 110, clientY: 120 }
      ],
      rect,
      null
    )

    expect(action).toEqual({
      kind: 'gesture',
      points: [
        { type: 'begin', x: 0.5, y: 0.94, edge: 3 },
        { type: 'move', x: 0.5, y: 0.6, edge: 3 },
        { type: 'end', x: 0.5, y: 0.25, edge: 3 }
      ]
    })
  })

  it('maps wheel deltas into opposite-direction touch movement', () => {
    const delta = resolveEmulatorWheelDelta(
      { clientX: 110, clientY: 220, deltaX: 0, deltaY: 80 },
      rect,
      null,
      1
    )

    expect(delta?.start).toEqual({ x: 0.5, y: 0.5 })
    expect(delta?.delta.x).toBeCloseTo(0)
    expect(delta?.delta.y).toBeCloseTo(-0.2)
  })

  it('builds a wheel gesture with a move point', () => {
    expect(buildWheelGesturePoints({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.25 })).toEqual([
      { type: 'begin', x: 0.5, y: 0.5 },
      { type: 'move', x: 0.5, y: 0.375 },
      { type: 'end', x: 0.5, y: 0.25 }
    ])
  })

  it('accounts for letterboxed stream content', () => {
    expect(
      mapClientPointToSimulatorScreen({ clientX: 110, clientY: 220 }, rect, {
        width: 100,
        height: 100
      })
    ).toEqual({ x: 0.5, y: 0.5 })
    expect(
      mapClientPointToSimulatorScreen({ clientX: 110, clientY: 30 }, rect, {
        width: 100,
        height: 100
      })
    ).toBeNull()
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
