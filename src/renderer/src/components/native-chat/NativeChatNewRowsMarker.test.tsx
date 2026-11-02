// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatNewRowsMarker } from './NativeChatNewRowsMarker'
import type { NativeChatNewRowsMarkerState as Marker } from './native-chat-new-rows-marker'
import { overrideLayoutProperty } from './native-chat-windowing-test-harness'

afterEach(cleanup)

function marker(overrides: Partial<Marker> = {}): Marker {
  return {
    key: 'answer',
    place: 'above-row',
    arriving: true,
    onArrived: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides
  }
}

const VIEWPORT_PX = 600
const ROW_TOP_PX = 1_000

let restoreLayout: (() => void)[] = []

/** A chat pane whose marker sits `intoRowPx` down its row. The view's bottom edge rests
 *  `aboveMarkerPx` short of the marker: 0 for a reader who was at the end of what there was. */
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
  const view = render(
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
  return { ...view, onReveal }
}

describe('NativeChatNewRowsMarker', () => {
  afterEach(() => {
    for (const restore of restoreLayout) {
      restore()
    }
  })

  it('brings its row to the top for a reader who was at the end', () => {
    const value = marker()
    const { container, onReveal } = pane(value)
    expect(onReveal).toHaveBeenCalledWith(container.querySelector('[data-index]'))
    expect(value.onArrived).toHaveBeenCalled()
  })

  // Under a prompt the reader expanded, the row's top would leave the marker below the view.
  it('brings itself to the top when it sits too far down its row to show with it', () => {
    const { onReveal } = pane(marker({ place: 'above-turn-bar' }), { intoRowPx: 500 })
    expect(onReveal).toHaveBeenCalledWith(screen.getByRole('separator'))
  })

  // They scrolled up to read something else before they left: that place is theirs to keep.
  it('leaves a reader who had parked the view above the new rows where they were', () => {
    const value = marker()
    const { onReveal } = pane(value, { aboveMarkerPx: 400 })
    expect(onReveal).not.toHaveBeenCalled()
    expect(value.onArrived).toHaveBeenCalled()
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
})
