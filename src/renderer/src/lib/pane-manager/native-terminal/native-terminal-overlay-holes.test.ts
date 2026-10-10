// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  boxShadowExtent,
  describeOverlay,
  mergeOverlappingRects,
  overlayHoles,
  overlaysTakeKeyboard,
  type NativeTerminalOverlay
} from './native-terminal-overlay-holes'

const PANE = new DOMRect(0, 0, 800, 600)

function overlay(rect: DOMRect, alwaysCovers = false): NativeTerminalOverlay {
  return { rect, padded: rect, alwaysCovers, takesKeyboard: true }
}

function box(rect: DOMRect): number[] {
  return [rect.left, rect.top, rect.width, rect.height]
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('boxShadowExtent', () => {
  it('measures how far outer shadows reach past each side', () => {
    expect(
      boxShadowExtent('rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.1) 0px 2px 4px -2px')
    ).toEqual({ top: 1, right: 5, bottom: 9, left: 5 })
  })

  it('ignores inset shadows and no shadow at all', () => {
    expect(boxShadowExtent('none')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(boxShadowExtent('rgb(0, 0, 0) 0px 0px 8px 0px inset')).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    })
  })
})

describe('mergeOverlappingRects', () => {
  it('keeps merging when a grown box reaches one already passed over', () => {
    const merged = mergeOverlappingRects([
      new DOMRect(0, 0, 10, 10),
      new DOMRect(20, 0, 10, 10),
      new DOMRect(8, 5, 14, 2)
    ])
    expect(merged.map(box)).toEqual([[0, 0, 30, 10]])
  })

  it('leaves disjoint rects alone', () => {
    const rects = [new DOMRect(0, 0, 10, 10), new DOMRect(20, 20, 10, 10)]
    expect(mergeOverlappingRects(rects).map(box)).toEqual(rects.map(box))
  })
})

describe('overlayHoles', () => {
  it('cuts one hole per menu or tooltip, clipped to the pane', () => {
    const holes = overlayHoles(PANE, [overlay(new DOMRect(700, 100, 200, 120))])
    expect(holes?.map(box)).toEqual([[700, 100, 100, 120]])
  })

  it('has no holes when nothing overlaps the pane', () => {
    expect(overlayHoles(PANE, [overlay(new DOMRect(900, 0, 50, 50))])).toEqual([])
  })

  it('hides the view for modal dialogs, search and drops however small', () => {
    expect(overlayHoles(PANE, [overlay(new DOMRect(10, 10, 20, 20), true)])).toBeNull()
  })

  it('hides the view once holes would cover most of the pane', () => {
    expect(overlayHoles(PANE, [overlay(new DOMRect(0, 0, 800, 301))])).toBeNull()
  })
})

describe('describeOverlay', () => {
  it('pads the hole by the shadow on the popper content', () => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.style.boxShadow = 'rgba(0, 0, 0, 0.1) 0px 4px 6px -1px'
    wrapper.appendChild(menu)
    document.body.appendChild(wrapper)
    const described = describeOverlay(wrapper, new DOMRect(100, 100, 200, 100))
    expect(box(described.padded)).toEqual([93, 97, 214, 114])
    expect(described.alwaysCovers).toBe(false)
  })

  it('lets menus take the keyboard but never tooltips', () => {
    const tooltip = document.createElement('div')
    tooltip.setAttribute('data-radix-popper-content-wrapper', '')
    const label = document.createElement('div')
    label.setAttribute('data-slot', 'tooltip-content')
    tooltip.appendChild(label)
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(tooltip, menu)
    const rect = new DOMRect(10, 10, 20, 20)
    const tip = describeOverlay(tooltip, rect)
    expect(tip.takesKeyboard).toBe(false)
    expect(overlaysTakeKeyboard(PANE, [tip])).toBe(false)
    expect(overlaysTakeKeyboard(PANE, [tip, describeOverlay(menu, rect)])).toBe(true)
    expect(overlaysTakeKeyboard(PANE, [describeOverlay(menu, new DOMRect(900, 0, 9, 9))])).toBe(
      false
    )
  })

  it('treats a dialog inside a popper as a popover, and one outside as modal', () => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    const popover = document.createElement('div')
    popover.setAttribute('role', 'dialog')
    wrapper.appendChild(popover)
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    document.body.append(wrapper, modal)
    const rect = new DOMRect(0, 0, 10, 10)
    expect(describeOverlay(popover, rect).alwaysCovers).toBe(false)
    expect(describeOverlay(modal, rect).alwaysCovers).toBe(true)
  })
})
