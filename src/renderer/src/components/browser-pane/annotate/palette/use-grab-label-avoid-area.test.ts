// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { parseGrabLabelAvoidArea } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { measureGrabLabelAvoidArea, useGrabLabelAvoidArea } from './use-grab-label-avoid-area'

function elementAt(left: number, top: number, width: number, height: number): HTMLElement {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => new DOMRect(left, top, width, height)
  return element
}

describe('the palette footprint sent to the picker', () => {
  it('returns the union of the given palette and hint rects, relative to the frame rect', () => {
    const frame = elementAt(100, 50, 800, 600)
    const palette = elementAt(400, 58, 240, 38)
    const hint = elementAt(400, 104, 300, 20)

    expect(measureGrabLabelAvoidArea(frame, [palette, hint])).toEqual({
      x: 300,
      y: 8,
      width: 300,
      height: 66,
      frameWidth: 800,
      frameHeight: 600
    })
  })

  it('ignores a null cover and returns null for a zero-size frame', () => {
    const palette = elementAt(400, 58, 240, 38)
    expect(measureGrabLabelAvoidArea(elementAt(100, 50, 800, 600), [palette, null])?.height).toBe(
      38
    )
    expect(measureGrabLabelAvoidArea(elementAt(0, 0, 0, 0), [palette])).toBeNull()
  })
})

describe('validating a footprint from the renderer', () => {
  it('accepts finite numbers and null', () => {
    const area = { x: 1, y: 2, width: 3, height: 4, frameWidth: 5, frameHeight: 6 }
    expect(parseGrabLabelAvoidArea(area)).toEqual(area)
    expect(parseGrabLabelAvoidArea(null)).toBeNull()
  })

  it('rejects anything that could reach the page as more than a number', () => {
    const valid = { x: 1, y: 2, width: 3, height: 4, frameWidth: 5, frameHeight: 6 }
    expect(parseGrabLabelAvoidArea(undefined)).toBeUndefined()
    expect(parseGrabLabelAvoidArea('x')).toBeUndefined()
    expect(parseGrabLabelAvoidArea({ ...valid, x: '1;alert(1)' })).toBeUndefined()
    expect(parseGrabLabelAvoidArea({ ...valid, width: Number.NaN })).toBeUndefined()
    expect(parseGrabLabelAvoidArea({ ...valid, y: Infinity })).toBeUndefined()
    expect(parseGrabLabelAvoidArea({ ...valid, frameWidth: 0 })).toBeUndefined()
    expect(parseGrabLabelAvoidArea({ ...valid, height: -1 })).toBeUndefined()
    expect(parseGrabLabelAvoidArea({ ...valid, x: 1e9 })).toBeUndefined()
  })
})

afterEach(cleanup)

it('keeps the newer mount footprint after an older mount finishes and withdraws', async () => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let applied: unknown = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        setGrabLabelAvoidArea: async ({ area }: { area: { x: number } | null }) => {
          if (area?.x === 300) {
            await held
          }
          applied = area
          return true
        }
      }
    }
  })
  const mount = (left: number) =>
    renderHook(() =>
      useGrabLabelAvoidArea({
        pageId: 'same-mounted-page',
        enabled: true,
        layoutKey: 'steady',
        frameRef: { current: elementAt(100, 50, 800, 600) },
        paletteRef: { current: elementAt(left, 58, 240, 38) },
        hintRef: { current: null }
      })
    )
  const old = mount(400)
  old.unmount()
  mount(500)
  await act(async () => {
    release?.()
    await held
  })
  expect(applied).toEqual({
    x: 400,
    y: 8,
    width: 240,
    height: 38,
    frameWidth: 800,
    frameHeight: 600
  })
})
