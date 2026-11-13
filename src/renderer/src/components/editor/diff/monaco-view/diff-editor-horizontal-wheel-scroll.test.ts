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
  it('moves right by one pixel once quarter-pixel swipes add up to it', () => {
    const { original } = installPanes(10)

    const events = swipe(original.container, 0.25, 4)

    expect(original.getScrollLeft()).toBe(11)
    expect(events.map((event) => event.defaultPrevented)).toEqual([true, true, true, true])
  })
})
