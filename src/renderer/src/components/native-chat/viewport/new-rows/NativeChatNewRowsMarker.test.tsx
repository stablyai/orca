// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NativeChatNewRowsMarker,
  NEW_ROWS_MARKER_FADE_MS,
  NEW_ROWS_MARKER_LINGER_MS
} from './NativeChatNewRowsMarker'
import type { NativeChatNewRowsMarkerState as Marker } from './native-chat-new-rows-marker'
import { overrideLayoutProperty } from '../virtualization/native-chat-windowing-test-harness'

afterEach(cleanup)

/** happy-dom never reports intersections; `showWhole` reports the marker fully in view, or not. */
/** The part of an observation the marker reads. */
type Sighting = (entries: { target: Element; intersectionRatio: number }[]) => void
const intersections: { callback: Sighting; target: Element | null }[] = []
function showWhole(whole: boolean): void {
  act(() => {
    for (const { callback, target } of intersections) {
      if (target) {
        callback([{ target, intersectionRatio: whole ? 1 : 0.4 }])
      }
    }
  })
}
class FakeIntersectionObserver {
  private readonly entry: { callback: Sighting; target: Element | null }
  constructor(callback: Sighting) {
    this.entry = { callback, target: null }
    intersections.push(this.entry)
  }
  observe(target: Element): void {
    this.entry.target = target
  }
  disconnect(): void {
    intersections.splice(intersections.indexOf(this.entry), 1)
  }
}

function marker(overrides: Partial<Marker> = {}): Marker {
  return {
    key: 'answer',
    place: 'above-row',
    look: 'line',
    arriving: true,
    watching: true,
    onArrived: vi.fn(),
    onDismiss: vi.fn(),
    onMeasured: vi.fn(),
    onFaded: vi.fn(),
    ...overrides
  }
}

const VIEWPORT_PX = 600
const ROW_TOP_PX = 1_000

let restoreLayout: (() => void)[] = []

/** Place the view bottom aboveMarkerPx short of a marker positioned intoRowPx within its row. */
function pane(
  value: Marker,
  { intoRowPx = 0, aboveMarkerPx = 0 }: { intoRowPx?: number; aboveMarkerPx?: number } = {}
) {
  const isRow = (element: HTMLElement): boolean => element.hasAttribute('data-index')
  const isMarker = (element: HTMLElement): boolean => element.getAttribute('role') === 'separator'
  const layout = (name: string, get: (this: HTMLElement) => unknown) =>
    overrideLayoutProperty(name, { get })
  restoreLayout = [
    layout('clientHeight', () => VIEWPORT_PX),
    layout('scrollTop', () => ROW_TOP_PX + intoRowPx - VIEWPORT_PX - aboveMarkerPx),
    layout('offsetTop', function () {
      return isRow(this) ? ROW_TOP_PX : isMarker(this) ? intoRowPx : 0
    }),
    layout('offsetParent', function () {
      return isRow(this) || isMarker(this) ? this.parentElement : null
    })
  ]
  const onReveal = vi.fn()
  const view = render(paneWith(value, onReveal))
  return { ...view, onReveal }
}

function paneWith(value: Marker, onReveal: (element: HTMLElement) => void): React.JSX.Element {
  return (
    <div data-native-chat-root="true">
      <div data-native-chat-typing-redirect-ignore="true">
        <input aria-label="Find in chat" />
      </div>
      <div data-native-chat-scroll>
        <div data-index="3">
          <NativeChatNewRowsMarker marker={value} onReveal={onReveal} />
        </div>
      </div>
      <textarea aria-label="composer" />
    </div>
  )
}

/** The marker as drawn in a pane, re-drawn with what changed. */
function drawn(value: Marker) {
  const view = pane(value)
  return {
    ...view,
    redraw: (overrides: Partial<Marker>) =>
      view.rerender(paneWith({ ...value, ...overrides }, view.onReveal))
  }
}

describe('NativeChatNewRowsMarker', () => {
  afterEach(() => {
    for (const restore of restoreLayout) {
      restore()
    }
  })

  it('brings itself to the top when it sits too far down its row to show with it', () => {
    const { onReveal } = pane(marker({ place: 'above-turn-bar' }), { intoRowPx: 500 })
    expect(onReveal).toHaveBeenCalledWith(screen.getByRole('separator'))
  })

  it('does not pull the reader back to it once it has arrived', () => {
    const { onReveal } = pane(marker({ arriving: false }))
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('goes once the reader writes to this chat, not to another pane or its find field', () => {
    const value = marker()
    pane(value)
    const typeIn = (target: Element) =>
      fireEvent(target, new Event('beforeinput', { bubbles: true }))
    typeIn(document.body)
    typeIn(screen.getByLabelText('Find in chat'))
    expect(value.onDismiss).not.toHaveBeenCalled()

    typeIn(screen.getByLabelText('composer'))
    expect(value.onDismiss).toHaveBeenCalledOnce()
  })

  describe('weighing whether what came needs a line', () => {
    /** Lay the transcript's rows out to end missedPx below the marker, with more drawn after them. */
    function measured(missedPx: number, viewportPx = VIEWPORT_PX): Marker {
      const value = marker({ look: 'measure' })
      const isRows = (element: HTMLElement): boolean =>
        element.hasAttribute('data-native-chat-window')
      restoreLayout = [
        overrideLayoutProperty('clientHeight', { get: () => viewportPx }),
        overrideLayoutProperty('offsetTop', {
          get(this: HTMLElement) {
            return this.hasAttribute('data-index') ? 400 : 0
          }
        }),
        overrideLayoutProperty('offsetParent', {
          get(this: HTMLElement) {
            return this.hasAttribute('data-native-chat-scroll') ? null : this.parentElement
          }
        }),
        overrideLayoutProperty('offsetHeight', {
          get(this: HTMLElement) {
            if (this.hasAttribute('data-native-chat-transcript-column')) {
              // Held sends and the activity line below the rows: not what the reader missed.
              return 400 + missedPx + 5_000
            }
            return isRows(this) ? 400 + missedPx : 0
          }
        })
      ]
      render(
        <div data-native-chat-root="true">
          <div data-native-chat-scroll>
            <div data-native-chat-transcript-column>
              <div data-native-chat-window>
                <div data-index="3">
                  <NativeChatNewRowsMarker marker={value} onReveal={vi.fn()} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )
      return value
    }

    it('calls for a line when more than a view came below it', () => {
      expect(measured(601).onMeasured).toHaveBeenCalledWith(true)
    })

    it('calls for none when what came fits in a view, and does not move the reader', () => {
      const value = measured(600)
      expect(value.onMeasured).toHaveBeenCalledWith(false)
      expect(value.onArrived).not.toHaveBeenCalled()
    })

    it('calls for a line when the pane has no layout to measure', () => {
      expect(measured(10_000, 0).onMeasured).toHaveBeenCalledWith(true)
    })

    it('is laid out unseen while it measures', () => {
      measured(100)
      expect(screen.queryByRole('separator')).toBeNull()
      expect(document.querySelector('.invisible')).not.toBeNull()
    })
  })

  describe('once seen', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('stays for 3 s fully in view, then counts as seen', () => {
      const value = marker({ arriving: false })
      drawn(value)
      showWhole(true)
      act(() => void vi.advanceTimersByTime(NEW_ROWS_MARKER_LINGER_MS - 1))
      expect(value.onFaded).not.toHaveBeenCalled()

      act(() => void vi.advanceTimersByTime(1))
      expect(value.onFaded).toHaveBeenCalledOnce()
    })

    it('starts its 3 s over when it leaves view or the reader looks away first', () => {
      const value = marker({ arriving: false })
      const { redraw } = drawn(value)
      showWhole(true)
      act(() => void vi.advanceTimersByTime(2_000))
      showWhole(false)
      showWhole(true)
      act(() => void vi.advanceTimersByTime(2_000))
      redraw({ watching: false })
      redraw({ watching: true })
      act(() => void vi.advanceTimersByTime(NEW_ROWS_MARKER_LINGER_MS - 1))
      expect(value.onFaded).not.toHaveBeenCalled()

      act(() => void vi.advanceTimersByTime(1))
      expect(value.onFaded).toHaveBeenCalledOnce()
    })

    it('does not run while only partly in view', () => {
      const value = marker({ arriving: false })
      drawn(value)
      showWhole(false)
      act(() => void vi.advanceTimersByTime(10_000))
      expect(value.onFaded).not.toHaveBeenCalled()
    })

    it('fades out over 480 ms once seen, or at once for a reader who asks for less motion', () => {
      const { redraw } = drawn(marker({ arriving: false }))
      redraw({ look: 'faded' })
      const faded = document.querySelector<HTMLElement>('[data-index] > div')
      expect(faded).toHaveClass('opacity-0', 'transition-opacity', 'motion-reduce:transition-none')
      expect(faded?.style.transitionDuration).toBe(`${NEW_ROWS_MARKER_FADE_MS}ms`)
    })

    it('keeps its place and size once faded, but is no longer read as a separator', () => {
      const { redraw } = drawn(marker({ arriving: false }))
      const line = document.querySelector<HTMLElement>('[data-index] > div')
      const before = line?.className
      redraw({ look: 'faded' })
      const faded = document.querySelector<HTMLElement>('[data-index] > div')
      expect(screen.queryByRole('separator')).toBeNull()
      expect(faded).toHaveAttribute('aria-hidden', 'true')
      expect(faded).toHaveClass('opacity-0')
      expect(faded?.className.replace(' opacity-0', '')).toBe(before)
      // The same element, not a new one: a remount could not hold its place through the fade.
      expect(faded).toBe(line)
      expect(faded?.textContent).toBe('New')
    })

    it('still goes at once when the reader writes to this chat after it faded', () => {
      const value = marker({ arriving: false })
      const { redraw } = drawn(value)
      redraw({ look: 'faded' })
      fireEvent(screen.getByLabelText('composer'), new Event('beforeinput', { bubbles: true }))
      expect(value.onDismiss).toHaveBeenCalledOnce()
    })
  })
})
