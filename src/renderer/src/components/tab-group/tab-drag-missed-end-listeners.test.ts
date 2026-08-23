/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTabDragMissedEndListeners } from './tab-drag-missed-end-listeners'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('installTabDragMissedEndListeners', () => {
  it('ignores blur and focus only while the pointer remains outside', () => {
    let outside = true
    const onMissedEnd = vi.fn()
    const release = installTabDragMissedEndListeners(onMissedEnd, () => outside)

    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
    vi.runAllTimers()
    expect(onMissedEnd).not.toHaveBeenCalled()

    outside = false
    window.dispatchEvent(new Event('blur'))
    outside = true
    vi.runAllTimers()
    expect(onMissedEnd).not.toHaveBeenCalled()

    outside = false
    window.dispatchEvent(new Event('focus'))
    vi.runAllTimers()
    expect(onMissedEnd).toHaveBeenCalledOnce()
    release()
  })

  it.each(['pointerup', 'pointercancel'])('cleans an outside drag on %s', (eventName) => {
    const onMissedEnd = vi.fn()
    const release = installTabDragMissedEndListeners(onMissedEnd, () => true)

    window.dispatchEvent(new Event(eventName))
    vi.runAllTimers()

    expect(onMissedEnd).toHaveBeenCalledOnce()
    release()
  })

  it('cancels a queued window-transition cleanup when drag end releases the listeners', () => {
    const onMissedEnd = vi.fn()
    const release = installTabDragMissedEndListeners(onMissedEnd)

    window.dispatchEvent(new Event('blur'))
    release()
    vi.runAllTimers()

    expect(onMissedEnd).not.toHaveBeenCalled()
  })
})
