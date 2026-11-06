// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import {
  getOverlayFocusOwners,
  getOverlayFocusSources,
  handleOverlayCloseAutoFocus,
  isOverlayFocusSourceDismissed
} from '@/lib/overlay-focus-ownership'
import { useOverlayFocusScope } from './use-overlay-focus-scope'

afterEach(cleanup)

function RetainedOverlay({ mounted, open }: { mounted: boolean; open: boolean }) {
  const { ref } = useOverlayFocusScope()
  return mounted ? <div ref={ref} role="menu" data-state={open ? 'open' : 'closed'} /> : null
}

it.each([false, true])(
  'restores focus ownership when a retained overlay reopens (initially mounted: %s)',
  async (initiallyMounted) => {
    const view = render(<RetainedOverlay mounted={initiallyMounted} open />)
    if (!initiallyMounted) {
      view.rerender(<RetainedOverlay mounted open />)
    }
    const owner = screen.getByRole('menu')
    expect(getOverlayFocusOwners()).toContain(owner)

    view.rerender(<RetainedOverlay mounted open={false} />)
    await act(async () => {
      const event = new Event('focusScope.autoFocusOnUnmount')
      owner.addEventListener(event.type, handleOverlayCloseAutoFocus, { once: true })
      owner.dispatchEvent(event)
    })
    expect(getOverlayFocusOwners()).not.toContain(owner)
    expect(getOverlayFocusSources()).not.toContain(owner)
    expect(isOverlayFocusSourceDismissed(owner)).toBe(true)

    view.rerender(<RetainedOverlay mounted open />)
    expect(screen.getByRole('menu')).toBe(owner)
    await waitFor(() => {
      expect(getOverlayFocusOwners()).toContain(owner)
      expect(getOverlayFocusSources()).toContain(owner)
      expect(isOverlayFocusSourceDismissed(owner)).toBe(false)
    })
  }
)
