import { describe, expect, it } from 'vitest'
import { fitDeviceFrameToPane, resolveDeviceFrameKind } from './emulator-device-frame-layout'

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
})
