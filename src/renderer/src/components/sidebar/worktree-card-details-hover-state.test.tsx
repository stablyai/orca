// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'

type HoverControlSnapshot = ReturnType<typeof useWorktreeCardDetailsHoverControl>

function HoverControlProbe({
  onChange
}: {
  onChange: (control: HoverControlSnapshot) => void
}): null {
  const control = useWorktreeCardDetailsHoverControl()
  onChange(control)
  return null
}

describe('useWorktreeCardDetailsHoverControl', () => {
  let container: HTMLDivElement
  let root: Root
  let control: HoverControlSnapshot | null = null

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    control = null
  })

  function mountProbe(): void {
    container = document.createElement('div')
    root = createRoot(container)
    act(() => {
      root.render(
        <HoverControlProbe
          onChange={(next) => {
            control = next
          }}
        />
      )
    })
  }

  it('keeps the hover open while the review menu is open', () => {
    mountProbe()
    expect(control).not.toBeNull()

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.handleReviewMenuOpenChange(true)
    })
    expect(control?.hoverOpen).toBe(true)

    act(() => {
      control?.handleHoverOpenChange(false)
    })
    expect(control?.hoverOpen).toBe(true)
  })

  it('closes the hover after the review menu dismisses a deferred close', () => {
    mountProbe()
    expect(control).not.toBeNull()

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.handleReviewMenuOpenChange(true)
      control?.handleHoverOpenChange(false)
    })
    expect(control?.hoverOpen).toBe(true)

    act(() => {
      control?.handleReviewMenuOpenChange(false)
    })
    expect(control?.hoverOpen).toBe(false)
  })

  it('clears a deferred close when the pointer returns before the menu closes', () => {
    mountProbe()
    expect(control).not.toBeNull()

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.handleReviewMenuOpenChange(true)
      control?.handleHoverOpenChange(false)
      control?.handleHoverOpenChange(true)
      control?.handleReviewMenuOpenChange(false)
    })

    expect(control?.hoverOpen).toBe(true)
  })

  it('closes both layers from closeHover', () => {
    mountProbe()
    expect(control).not.toBeNull()

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.handleReviewMenuOpenChange(true)
      control?.closeHover()
    })

    expect(control?.hoverOpen).toBe(false)
    expect(control?.reviewMenuOpen).toBe(false)
  })

  it('keeps a menu that opened in the same click that dismissed the link chooser', () => {
    mountProbe()

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.handleLinkActionsOpenChange(true)
      control?.handleReviewMenuOpenChange(true)
      control?.handleLinkActionsOpenChange(false)
    })

    expect(control?.reviewMenuOpen).toBe(true)
  })

  it('keeps the card open behind the link chooser after the pointer moves onto it', () => {
    mountProbe()

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.handleLinkActionsOpenChange(true)
      control?.handleHoverOpenChange(false)
      control?.handleLinkActionsOpenChange(false)
    })

    expect(control?.hoverOpen).toBe(true)
  })

  it('holds the card open while unfocused only after an external link open', () => {
    mountProbe()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.handleHoverOpenChange(false)
    })
    expect(control?.hoverOpen).toBe(false)

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.holdOpenUntilRefocus()
      control?.handleHoverOpenChange(false)
    })
    expect(control?.hoverOpen).toBe(true)

    act(() => {
      window.dispatchEvent(new Event('focus'))
      control?.handleHoverOpenChange(false)
    })
    expect(control?.hoverOpen).toBe(false)
    hasFocus.mockRestore()
  })
})
