// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDiffEditorHorizontalWheelScroll } from './diff-editor-horizontal-wheel-scroll'

function createPane(initialScrollLeft: number) {
  const container = document.createElement('div')
  let scrollLeft = initialScrollLeft
  Object.defineProperty(container, 'clientWidth', { value: 200 })
  document.body.appendChild(container)
  return {
    container,
    setScrollLeft: vi.fn((value: number) => {
      // Monaco stores integer scroll positions.
      scrollLeft = Math.trunc(value)
    }),
    getScrollLeft: () => scrollLeft,
    getContainerDomNode: () => container,
    getScrollWidth: () => 1000,
    getLayoutInfo: () => ({ contentWidth: 200 })
  }
}

function dispatchWheel(
  target: HTMLElement,
  init: WheelEventInit & { timeStamp?: number }
): WheelEvent {
  const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true })
  // Happy DOM's WheelEvent omits mouse modifier fields.
  Object.defineProperty(event, 'shiftKey', { value: init.shiftKey ?? false })
  Object.defineProperty(event, 'timeStamp', { value: init.timeStamp ?? 0 })
  target.dispatchEvent(event)
  return event
}

function swipe(target: HTMLElement, deltaX: number, count: number): WheelEvent[] {
  return Array.from({ length: count }, () => dispatchWheel(target, { deltaX }))
}

function installPanes(originalScrollLeft: number) {
  const original = createPane(originalScrollLeft)
  const modified = createPane(10)
  installDiffEditorHorizontalWheelScroll({
    getOriginalEditor: () => original,
    getModifiedEditor: () => modified
  })
  return { original, modified }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('installDiffEditorHorizontalWheelScroll', () => {
  it('scrolls only the pane under the pointer on a sideways swipe without Shift', () => {
    const { original, modified } = installPanes(10)

    const event = dispatchWheel(original.container, { deltaX: 30, deltaY: 4 })

    expect(original.setScrollLeft).toHaveBeenCalledWith(40)
    expect(modified.setScrollLeft).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a mostly vertical swipe untouched for the outer list', () => {
    const { original } = installPanes(10)

    const event = dispatchWheel(original.container, { deltaX: 5, deltaY: 40 })

    expect(original.setScrollLeft).not.toHaveBeenCalled()
    expect(original.getScrollLeft()).toBe(10)
    expect(event.defaultPrevented).toBe(false)
  })

  it('scrolls sideways from a vertical wheel while Shift is held', () => {
    const { original } = installPanes(10)

    const event = dispatchWheel(original.container, { deltaX: 5, deltaY: 40, shiftKey: true })

    expect(original.getScrollLeft()).toBe(50)
    expect(event.defaultPrevented).toBe(true)
  })

  it('hands the gesture to the outer list when the pane is already at its edge', () => {
    const { original } = installPanes(800)

    const event = dispatchWheel(original.container, { deltaY: 30, shiftKey: true })

    expect(original.setScrollLeft).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('moves right by one pixel once quarter-pixel swipes add up to it', () => {
    const { original } = installPanes(10)

    const events = swipe(original.container, 0.25, 4)

    expect(original.getScrollLeft()).toBe(11)
    expect(events.map((event) => event.defaultPrevented)).toEqual([true, true, true, true])
  })

  it('moves left by one pixel once quarter-pixel swipes add up to it', () => {
    const { original } = installPanes(10)

    swipe(original.container, -0.25, 4)

    expect(original.getScrollLeft()).toBe(9)
  })

  it('starts over when the swipe changes direction', () => {
    const { original } = installPanes(10)

    swipe(original.container, 0.25, 3)
    swipe(original.container, -0.25, 3)
    expect(original.getScrollLeft()).toBe(10)

    swipe(original.container, -0.25, 1)
    expect(original.getScrollLeft()).toBe(9)
  })

  it('drops a partial pixel left over from an earlier gesture', () => {
    const { original } = installPanes(10)

    dispatchWheel(original.container, { deltaX: 0.75, timeStamp: 1000 })
    dispatchWheel(original.container, { deltaX: 0.25, timeStamp: 1151 })
    expect(original.getScrollLeft()).toBe(10)

    dispatchWheel(original.container, { deltaX: 0.75, timeStamp: 1301 })
    expect(original.getScrollLeft()).toBe(11)
  })

  it('carries a partial pixel when the pointer crosses to the other pane', () => {
    const { original, modified } = installPanes(10)

    swipe(original.container, 0.25, 2)
    swipe(modified.container, 0.25, 2)

    expect(modified.getScrollLeft()).toBe(11)
    expect(original.getScrollLeft()).toBe(10)
  })

  it('hands partial-pixel swipes at the edge to the outer list', () => {
    const { original } = installPanes(800)

    const events = swipe(original.container, 0.25, 4)

    expect(original.getScrollLeft()).toBe(800)
    expect(events.map((event) => event.defaultPrevented)).toEqual([false, false, false, false])
  })
})
