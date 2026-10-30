import { describe, expect, it } from 'vitest'
import {
  fitDeviceFrameToPane,
  resolveVisualScreenAspectRatio,
  resolveVisualStreamGeometry
} from './emulator-device-frame-layout'

describe('resolveVisualStreamGeometry', () => {
  it('uses visual orientation for the interactive screen rectangle', () => {
    const geometry = resolveVisualStreamGeometry({ width: 390, height: 844 }, 'landscape')

    expect(geometry.size).toEqual({
      width: 844,
      height: 390
    })
    expect(geometry.streamRotation).toBe(90)
  })

  it('rotates a stale landscape stream back into portrait geometry', () => {
    const geometry = resolveVisualStreamGeometry({ width: 844, height: 390 }, 'portrait')

    expect(geometry.size).toEqual({
      width: 390,
      height: 844
    })
    expect(geometry.streamRotation).toBe(-90)
  })
})

describe('fitDeviceFrameToPane', () => {
  it('still returns usable dimensions for a narrow split pane', () => {
    const pane = { width: 260, height: 320 }
    const layout = fitDeviceFrameToPane(pane, 9 / 19, 'phone')

    expect(layout).not.toBeNull()
    expect(layout?.width).toBeLessThanOrEqual(pane.width)
    expect(layout?.height).toBeLessThanOrEqual(pane.height)
    expect(layout?.shellWidth).toBeGreaterThan(1)
    expect(layout?.shellHeight).toBeGreaterThan(1)
  })

  it('fits the entire phone frame as landscape after a device rotation', () => {
    const pane = { width: 1000, height: 600 }
    const aspectRatio = resolveVisualScreenAspectRatio({ width: 844, height: 390 }, 'landscape')
    const layout = fitDeviceFrameToPane(pane, aspectRatio, 'phone')

    expect(layout).not.toBeNull()
    expect(layout?.width).toBeLessThanOrEqual(pane.width)
    expect(layout?.height).toBeLessThanOrEqual(pane.height)
    expect(layout ? layout.shellWidth / layout.shellHeight : 0).toBeGreaterThan(1)
  })
})
