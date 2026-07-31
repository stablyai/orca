// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDiffEditorShiftWheelScroll } from './diff-editor-shift-wheel-scroll'

type PaneFixture = {
  container: HTMLDivElement
  input: HTMLDivElement
  setScrollLeft: ReturnType<typeof vi.fn<(value: number) => void>>
  getScrollLeft: () => number
  getContainerDomNode: () => HTMLElement
}

function createPaneFixture(initialScrollLeft = 10): PaneFixture {
  const container = document.createElement('div')
  const input = document.createElement('div')
  let scrollLeft = initialScrollLeft
  const setScrollLeft = vi.fn((value: number) => {
    scrollLeft = value
  })
  Object.defineProperty(container, 'clientWidth', { value: 200 })
  container.appendChild(input)
  document.body.appendChild(container)
  return {
    container,
    input,
    setScrollLeft,
    getScrollLeft: () => scrollLeft,
    getContainerDomNode: () => container
  }
}

function dispatchWheel(target: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true })
  // Happy DOM's WheelEvent omits mouse modifier fields.
  Object.defineProperty(event, 'shiftKey', { value: init.shiftKey ?? false })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('installDiffEditorShiftWheelScroll', () => {
  it.each([
    { label: 'vertical pixel input', init: { deltaY: 24 }, expected: 34 },
    { label: 'platform-converted horizontal input', init: { deltaX: 12 }, expected: 22 },
    {
      label: 'line-based input',
      init: { deltaY: -2, deltaMode: WheelEvent.DOM_DELTA_LINE },
      expected: -22
    },
    {
      label: 'page-based input',
      init: { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE },
      expected: 210
    }
  ])('scrolls the pane under the pointer for $label', ({ init, expected }) => {
    const original = createPaneFixture()
    const modified = createPaneFixture()
    const onDownstreamWheel = vi.fn()
    original.input.addEventListener('wheel', onDownstreamWheel)
    const dispose = installDiffEditorShiftWheelScroll({
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified
    })

    const event = dispatchWheel(original.input, { ...init, shiftKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(original.setScrollLeft).toHaveBeenCalledWith(expected)
    expect(modified.setScrollLeft).not.toHaveBeenCalled()
    expect(onDownstreamWheel).not.toHaveBeenCalled()
    dispose()
  })

  it('leaves ordinary vertical wheel input for the outer combined-diff scroller', () => {
    const original = createPaneFixture()
    const modified = createPaneFixture()
    const onDownstreamWheel = vi.fn()
    original.input.addEventListener('wheel', onDownstreamWheel)
    const dispose = installDiffEditorShiftWheelScroll({
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified
    })

    const event = dispatchWheel(original.input, { deltaY: 24 })

    expect(event.defaultPrevented).toBe(false)
    expect(original.setScrollLeft).not.toHaveBeenCalled()
    expect(onDownstreamWheel).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('removes both pane listeners when disposed', () => {
    const original = createPaneFixture()
    const modified = createPaneFixture()
    const dispose = installDiffEditorShiftWheelScroll({
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified
    })
    dispose()

    const originalEvent = dispatchWheel(original.input, { deltaY: 24, shiftKey: true })
    const modifiedEvent = dispatchWheel(modified.input, { deltaY: 24, shiftKey: true })

    expect(originalEvent.defaultPrevented).toBe(false)
    expect(modifiedEvent.defaultPrevented).toBe(false)
    expect(original.setScrollLeft).not.toHaveBeenCalled()
    expect(modified.setScrollLeft).not.toHaveBeenCalled()
  })
})
