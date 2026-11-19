// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { parseGrabLabelAvoidArea } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { measureGrabLabelAvoidArea } from './use-grab-label-avoid-area'

function elementAt(left: number, top: number, width: number, height: number): HTMLElement {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => new DOMRect(left, top, width, height)
  return element
}

describe('the palette footprint sent to the picker', () => {
  it('covers the palette and its hint, relative to the page frame', () => {
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

  it('skips a hidden hint and a hidden page', () => {
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
