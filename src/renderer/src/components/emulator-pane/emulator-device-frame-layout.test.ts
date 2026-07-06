import { describe, expect, it } from 'vitest'
import {
  fitDeviceFrameToPane,
  resolveDeviceFrameKind,
  resolveVisualScreenAspectRatio,
  resolveVisualStreamGeometry
} from './emulator-device-frame-layout'

describe('resolveDeviceFrameKind', () => {
  it('prefers device names over aspect-ratio fallback', () => {
    expect(resolveDeviceFrameKind('iPhone 17 Pro', 0.75)).toBe('phone')
    expect(resolveDeviceFrameKind('iPad Pro (13-inch)', 0.47)).toBe('tablet')
  })

  it('uses stream shape when the device name is unavailable', () => {
    expect(resolveDeviceFrameKind(undefined, 9 / 19)).toBe('phone')
    expect(resolveDeviceFrameKind(undefined, 3 / 4)).toBe('tablet')
  })
})

describe('resolveVisualScreenAspectRatio', () => {
  it('uses the requested orientation even when the stream canvas has not swapped yet', () => {
    const portraitStream = { width: 390, height: 844 }

    expect(resolveVisualScreenAspectRatio(portraitStream, 'portrait')).toBeCloseTo(390 / 844)
    expect(resolveVisualScreenAspectRatio(portraitStream, 'landscape')).toBeCloseTo(844 / 390)
  })

  it('uses the requested orientation only before a stream frame arrives', () => {
    expect(resolveVisualScreenAspectRatio(null, 'portrait')).toBeCloseTo(9 / 19)
    expect(resolveVisualScreenAspectRatio(null, 'landscape')).toBeCloseTo(19 / 9)
  })
})

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
  it('fits a phone shell and hardware controls inside the pane', () => {
    const pane = { width: 600, height: 1000 }
    const layout = fitDeviceFrameToPane(pane, 9 / 19, 'phone')

    expect(layout).not.toBeNull()
    expect(layout?.width).toBeLessThanOrEqual(pane.width)
    expect(layout?.height).toBeLessThanOrEqual(pane.height)
    expect(layout?.shellWidth).toBeLessThan(layout?.width ?? 0)
    expect(layout?.hardwareOutset).toBeGreaterThan(0)
    expect(layout?.sideButtonThickness).toBeLessThanOrEqual(layout?.hardwareOutset ?? 0)
    expect(layout?.outerRadius).toBeGreaterThan(layout?.innerRadius ?? 0)
    expect(layout ? layout.outerRadius - layout.innerRadius : 0).toBeCloseTo(layout?.bezel ?? 0, 5)
    expect(layout?.innerRadius).toBeGreaterThan(34)
  })

  it('keeps tablet frames simple and bounded', () => {
    const pane = { width: 900, height: 700 }
    const layout = fitDeviceFrameToPane(pane, 4 / 3, 'tablet')

    expect(layout).not.toBeNull()
    expect(layout?.width).toBeLessThanOrEqual(pane.width)
    expect(layout?.height).toBeLessThanOrEqual(pane.height)
    expect(layout?.hardwareOutset).toBe(0)
    expect(layout?.sideButtonThickness).toBe(0)
  })

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
