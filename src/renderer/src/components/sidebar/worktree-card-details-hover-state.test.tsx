// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
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
})
