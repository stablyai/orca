// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseGrabLabelAvoidArea,
  type BrowserGrabLabelAvoidArea
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
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

describe('reporting the footprint to main', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps offering it until main accepts it (the page registers a moment later)', async () => {
    vi.useFakeTimers()
    // Main as the IPC handler behaves: no area for a page it doesn't know yet.
    const main: { registered: boolean; held: BrowserGrabLabelAvoidArea | null } = {
      registered: false,
      held: null
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: {
          setGrabLabelAvoidArea: async ({ area }: { area: BrowserGrabLabelAvoidArea | null }) => {
            if (!main.registered && area !== null) {
              return false
            }
            main.held = area
            return true
          }
        }
      }
    })
    const frame = { current: elementAt(100, 50, 800, 600) }
    const palette = { current: elementAt(400, 58, 240, 38) }
    const hint = { current: null }
    renderHook(() =>
      useGrabLabelAvoidArea({
        pageId: 'page-1',
        frameRef: frame,
        paletteRef: palette,
        hintRef: hint,
        enabled: true,
        layoutKey: 'same'
      })
    )
    await act(async () => {})
    expect(main.held).toBeNull()

    main.registered = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(main.held).toEqual({
      x: 300,
      y: 8,
      width: 240,
      height: 38,
      frameWidth: 800,
      frameHeight: 600
    })
  })
})
