import { describe, expect, it } from 'vitest'
import { resolveVisualStreamGeometry } from './emulator-device-frame-layout'

describe('resolveVisualStreamGeometry', () => {
  it.each([
    { orientation: 'landscape_left', rotation: 90, width: 2853, height: 2007 },
    { orientation: 'landscape_right', rotation: -90, width: 2853, height: 2007 },
    { orientation: 'portrait_upside_down', rotation: 180, width: 2007, height: 2853 }
  ] as const)(
    'uses reported $orientation for raw panel geometry',
    ({ orientation, rotation, width, height }) => {
      const geometry = resolveVisualStreamGeometry(
        { width: 2007, height: 2853 },
        'portrait',
        orientation
      )
      expect(geometry.streamRotation).toBe(rotation)
      expect(geometry.size).toEqual({ width, height })
    }
  )

  it('preserves an already landscape frame', () => {
    expect(
      resolveVisualStreamGeometry({ width: 844, height: 390 }, 'portrait', 'landscape_left')
    ).toEqual({
      size: { width: 844, height: 390 },
      aspectRatio: 844 / 390,
      streamRotation: 0
    })
  })

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
