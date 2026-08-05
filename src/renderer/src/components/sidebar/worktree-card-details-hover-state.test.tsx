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

  function focusInsideWebviewGuest(): void {
    const webview = document.createElement('webview')
    document.body.append(webview)
    act(() => {
      webview.dispatchEvent(new Event('focusin', { bubbles: true }))
    })
    webview.remove()
  }

  it('closes the hover when focus moves into a webview guest', () => {
    mountProbe()

    act(() => {
      control?.handleHoverOpenChange(true)
    })
    expect(control?.hoverOpen).toBe(true)

    focusInsideWebviewGuest()

    expect(control?.hoverOpen).toBe(false)
  })

  it('closes the detail menu layer that would otherwise swallow the close', () => {
    mountProbe()

    act(() => {
      control?.handleHoverOpenChange(true)
      control?.handleReviewMenuOpenChange(true)
    })
    expect(control?.hoverOpen).toBe(true)

    focusInsideWebviewGuest()

    expect(control?.hoverOpen).toBe(false)
    expect(control?.reviewMenuOpen).toBe(false)
  })

  it('leaves a closed hover alone and ignores focus outside a guest', () => {
    mountProbe()

    focusInsideWebviewGuest()
    expect(control?.hoverOpen).toBe(false)

    act(() => {
      control?.handleHoverOpenChange(true)
    })
    const outside = document.createElement('div')
    document.body.append(outside)
    act(() => {
      outside.dispatchEvent(new Event('focusin', { bubbles: true }))
    })
    outside.remove()

    // Why: Radix owns dismissal for ordinary host DOM; only guest surfaces need the assist.
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
