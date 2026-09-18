// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTabDragMissedEndListeners } from './tab-drag-missed-end-listeners'

describe('installTabDragMissedEndListeners', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('triggers missed-end callback when pointer moves without primary button held', () => {
    const onMissedEnd = vi.fn()
    const release = installTabDragMissedEndListeners(onMissedEnd)

    // Moving without primary button held (buttons: 0)
    window.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 }))
    expect(onMissedEnd).not.toHaveBeenCalled()

    // Advance macrotask timer
    vi.runAllTimers()
    expect(onMissedEnd).toHaveBeenCalledTimes(1)

    release()
  })

  it('does not trigger missed-end callback when pointer moves with primary button held', () => {
    const onMissedEnd = vi.fn()
    const release = installTabDragMissedEndListeners(onMissedEnd)

    // Moving while dragging with primary button held (buttons: 1)
    window.dispatchEvent(new PointerEvent('pointermove', { buttons: 1 }))
    vi.runAllTimers()

    expect(onMissedEnd).not.toHaveBeenCalled()

    release()
  })

  it('triggers missed-end callback on window blur', () => {
    const onMissedEnd = vi.fn()
    const release = installTabDragMissedEndListeners(onMissedEnd)

    window.dispatchEvent(new Event('blur'))
    vi.runAllTimers()

    expect(onMissedEnd).toHaveBeenCalledTimes(1)

    release()
  })

  it('triggers missed-end callback on target auxiliary window events', () => {
    const onMissedEnd = vi.fn()
    const auxWindow = new EventTarget() as unknown as Window
    Object.defineProperty(auxWindow, 'document', { value: new EventTarget() })

    const release = installTabDragMissedEndListeners(onMissedEnd, auxWindow)

    auxWindow.dispatchEvent(new Event('blur'))
    vi.runAllTimers()

    expect(onMissedEnd).toHaveBeenCalledTimes(1)

    release()
  })
})
