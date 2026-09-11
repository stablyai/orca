// @vitest-environment happy-dom

// Why: the sibling tab-strip-reveal-hover.test.ts covers the pure zone rule; these drive the hook
// itself, because the latched-reveal bugs live in its subscribe/teardown, not in the geometry.
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTabStripRevealHover, TAB_STRIP_REVEAL_HOVER_ZONE_PX } from './tab-strip-reveal-hover'

function panelAt(rect: { left: number; right: number; top: number }): HTMLElement {
  const panel = document.createElement('div')
  panel.getBoundingClientRect = () =>
    ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.top + 600 }) as DOMRect
  return panel
}

function movePointer(clientX: number, clientY: number): void {
  const event = new Event('pointermove', { bubbles: true })
  Object.defineProperty(event, 'clientX', { value: clientX })
  Object.defineProperty(event, 'clientY', { value: clientY })
  window.dispatchEvent(event)
}

function renderHover(enabled: boolean, onHoverChange: (hovered: boolean) => void) {
  const panelRef = { current: panelAt({ left: 0, right: 400, top: 100 }) }
  return renderHook(
    ({ enabled: isEnabled }: { enabled: boolean }) =>
      useTabStripRevealHover({ enabled: isEnabled, panelRef, onHoverChange }),
    { initialProps: { enabled } }
  )
}

/** Pointer moves are coalesced through requestAnimationFrame, so flush one frame. */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

describe('useTabStripRevealHover', () => {
  it('reports a hover once the pointer enters the zone', async () => {
    const onHoverChange = vi.fn()
    renderHover(true, onHoverChange)

    act(() => movePointer(200, 105))
    await flushFrame()

    expect(onHoverChange).toHaveBeenCalledWith(true)
  })

  it('clears a latched reveal when the group stops being watched', async () => {
    const onHoverChange = vi.fn()
    const { rerender } = renderHover(true, onHoverChange)

    act(() => movePointer(200, 105))
    await flushFrame()
    onHoverChange.mockClear()

    // A worktree switch disables the hook mid-hover; the next enabled run restarts from
    // `hovered = false` and would never emit the clearing call on its own.
    rerender({ enabled: false })

    expect(onHoverChange).toHaveBeenCalledWith(false)
  })

  it('does not emit a clearing call when teardown finds no active hover', async () => {
    const onHoverChange = vi.fn()
    const { rerender } = renderHover(true, onHoverChange)

    act(() => movePointer(200, 100 + TAB_STRIP_REVEAL_HOVER_ZONE_PX + 50))
    await flushFrame()
    onHoverChange.mockClear()

    rerender({ enabled: false })

    expect(onHoverChange).not.toHaveBeenCalled()
  })

  it('stops watching the pointer while disabled', async () => {
    const onHoverChange = vi.fn()
    renderHover(false, onHoverChange)

    act(() => movePointer(200, 105))
    await flushFrame()

    expect(onHoverChange).not.toHaveBeenCalled()
  })
})
