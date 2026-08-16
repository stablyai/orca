// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  findTabGroupBodyElement,
  isMeasurableOverlayRect,
  isOverlaySlotGeometryMismatched,
  measureOverlaySlotRect,
  shouldPreferMeasuredOverlayGeometry
} from './overlay-slot-geometry'

function rect(
  partial: Partial<DOMRect> & Pick<DOMRect, 'top' | 'left' | 'width' | 'height'>
): DOMRect {
  const top = partial.top
  const left = partial.left
  const width = partial.width
  const height = partial.height
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

describe('overlay slot geometry', () => {
  it('finds the tab-group body scoped by worktree when both attributes are set', () => {
    const other = document.createElement('div')
    other.dataset.tabGroupBodyId = 'group-a'
    other.dataset.worktreeId = 'wt-other'
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'group-a'
    body.dataset.worktreeId = 'wt-1'
    document.body.append(other, body)
    expect(findTabGroupBodyElement('group-a', 'wt-1')).toBe(body)
    expect(findTabGroupBodyElement('group-a', 'wt-missing')).toBeNull()
    expect(findTabGroupBodyElement('group-a')).toBe(other)
    expect(findTabGroupBodyElement('missing')).toBeNull()
    other.remove()
    body.remove()
  })

  it('measures body geometry relative to the overlay parent (absolute containing block)', () => {
    const parent = document.createElement('div')
    const body = document.createElement('div')
    parent.getBoundingClientRect = () => rect({ top: 100, left: 40, width: 900, height: 700 })
    body.getBoundingClientRect = () => rect({ top: 136, left: 40, width: 450, height: 664 })
    expect(measureOverlaySlotRect(parent, body)).toEqual({
      top: 36,
      left: 0,
      width: 450,
      height: 664
    })
  })

  it('detects post-snap overlay/body desync beyond tolerance', () => {
    expect(
      isOverlaySlotGeometryMismatched(
        rect({ top: 0, left: 0, width: 900, height: 700 }),
        rect({ top: 136, left: 40, width: 450, height: 664 })
      )
    ).toBe(true)
    expect(
      isOverlaySlotGeometryMismatched(
        rect({ top: 136.5, left: 40.5, width: 450, height: 664 }),
        rect({ top: 136, left: 40, width: 450, height: 664 })
      )
    ).toBe(false)
  })

  it('forces measured geometry when CSS-anchor hit-test drifts after a side-by-side snap', () => {
    const parent = document.createElement('div')
    const overlay = document.createElement('div')
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'group-snap'
    body.dataset.worktreeId = 'wt-1'
    parent.appendChild(overlay)
    document.body.append(parent, body)

    // Why: after a column snap the overlay can still claim the pre-snap full-area
    // box while the body is only the right half — clicks then land in chrome/tabs.
    parent.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 1000, height: 800 })
    overlay.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 1000, height: 800 })
    body.getBoundingClientRect = () => rect({ top: 36, left: 500, width: 500, height: 764 })

    const result = shouldPreferMeasuredOverlayGeometry({
      overlay,
      groupId: 'group-snap',
      worktreeId: 'wt-1',
      forceMeasured: false,
      mayLatchDesync: true
    })
    expect(result.preferMeasured).toBe(true)
    expect(result.bodyMeasurable).toBe(true)
    expect(result.measured).toEqual({
      top: 36,
      left: 500,
      width: 500,
      height: 764
    })

    parent.remove()
    body.remove()
  })

  it('keeps CSS anchors when overlay geometry already matches the body', () => {
    const parent = document.createElement('div')
    const overlay = document.createElement('div')
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'group-ok'
    parent.appendChild(overlay)
    document.body.append(parent, body)

    const matched = rect({ top: 36, left: 0, width: 900, height: 700 })
    parent.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 900, height: 736 })
    overlay.getBoundingClientRect = () => matched
    body.getBoundingClientRect = () => matched

    const result = shouldPreferMeasuredOverlayGeometry({
      overlay,
      groupId: 'group-ok',
      forceMeasured: false,
      mayLatchDesync: true
    })
    expect(result.preferMeasured).toBe(false)
    expect(result.measured).toEqual({
      top: 36,
      left: 0,
      width: 900,
      height: 700
    })

    parent.remove()
    body.remove()
  })

  it('does not latch desync from a display:none / zero-size overlay sample', () => {
    const parent = document.createElement('div')
    const overlay = document.createElement('div')
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'group-hidden'
    parent.appendChild(overlay)
    document.body.append(parent, body)

    parent.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 1000, height: 800 })
    overlay.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 0, height: 0 })
    body.getBoundingClientRect = () => rect({ top: 36, left: 0, width: 1000, height: 764 })

    expect(
      shouldPreferMeasuredOverlayGeometry({
        overlay,
        groupId: 'group-hidden',
        forceMeasured: false,
        mayLatchDesync: true
      }).preferMeasured
    ).toBe(false)

    expect(
      shouldPreferMeasuredOverlayGeometry({
        overlay,
        groupId: 'group-hidden',
        forceMeasured: false,
        mayLatchDesync: false
      }).preferMeasured
    ).toBe(false)

    parent.remove()
    body.remove()
  })

  it('does not latch desync when the body is not yet measurable', () => {
    const parent = document.createElement('div')
    const overlay = document.createElement('div')
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'group-unlaid'
    parent.appendChild(overlay)
    document.body.append(parent, body)

    parent.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 1000, height: 800 })
    overlay.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 1000, height: 800 })
    body.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 0, height: 0 })

    const result = shouldPreferMeasuredOverlayGeometry({
      overlay,
      groupId: 'group-unlaid',
      forceMeasured: false,
      mayLatchDesync: true
    })
    expect(result.bodyMeasurable).toBe(false)
    expect(result.preferMeasured).toBe(false)
    expect(isMeasurableOverlayRect({ width: 0, height: 0 })).toBe(false)

    parent.remove()
    body.remove()
  })

  it('honors forceMeasured even when geometry currently matches', () => {
    const parent = document.createElement('div')
    const overlay = document.createElement('div')
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'group-forced'
    parent.appendChild(overlay)
    document.body.append(parent, body)

    const matched = rect({ top: 36, left: 0, width: 900, height: 700 })
    parent.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 900, height: 736 })
    overlay.getBoundingClientRect = () => matched
    body.getBoundingClientRect = () => matched

    expect(
      shouldPreferMeasuredOverlayGeometry({
        overlay,
        groupId: 'group-forced',
        forceMeasured: true,
        mayLatchDesync: true
      }).preferMeasured
    ).toBe(true)

    parent.remove()
    body.remove()
  })
})
