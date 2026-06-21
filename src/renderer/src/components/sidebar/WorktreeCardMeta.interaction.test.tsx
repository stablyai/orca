// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'

const interactionMocks = vi.hoisted(() => ({
  hoverOpen: false,
  onHoverOpenChange: undefined as ((open: boolean) => void) | undefined,
  reviewMenuOpen: false,
  onReviewMenuOpenChange: undefined as ((open: boolean) => void) | undefined,
  onUnlinkSelect: undefined as (() => void) | undefined
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    open,
    onOpenChange
  }: {
    children: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => {
    interactionMocks.hoverOpen = open ?? false
    interactionMocks.onHoverOpenChange = onOpenChange
    return <div data-hover-open={open ? 'true' : 'false'}>{children}</div>
  },
  HoverCardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children, open }: { children: ReactNode; open?: boolean }) => (
    <div data-tooltip-open={open === false ? 'false' : 'default'}>{children}</div>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    open,
    onOpenChange
  }: {
    children: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => {
    interactionMocks.reviewMenuOpen = open ?? false
    interactionMocks.onReviewMenuOpenChange = onOpenChange
    return <div data-review-menu-open={open ? 'true' : 'false'}>{children}</div>
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  )
}))

const reviewFixture = {
  provider: 'github' as const,
  number: 456,
  title: 'Fix stale GH PR',
  state: 'open' as const,
  url: 'https://github.com/acme/orca/pull/456',
  status: 'success' as const,
  updatedAt: '2026-05-17T00:00:00.000Z',
  mergeable: 'MERGEABLE' as const
}

describe('WorktreeCardDetailsHover interactions', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    interactionMocks.hoverOpen = false
    interactionMocks.reviewMenuOpen = false
    interactionMocks.onHoverOpenChange = undefined
    interactionMocks.onReviewMenuOpenChange = undefined
    interactionMocks.onUnlinkSelect = undefined
  })

  function renderHover(onUnlinkReview = vi.fn()): ReturnType<typeof vi.fn> {
    container = document.createElement('div')
    root = createRoot(container)
    act(() => {
      root.render(
        <WorktreeCardDetailsHover
          issue={null}
          linearIssue={null}
          review={reviewFixture}
          comment={null}
          onEditIssue={vi.fn()}
          onEditComment={vi.fn()}
          onOpenReviewInOrca={vi.fn()}
          onUnlinkReview={onUnlinkReview}
        >
          <span>Linked PR</span>
        </WorktreeCardDetailsHover>
      )
    })
    return onUnlinkReview
  }

  it('defers hover close while the review menu is open', () => {
    renderHover()

    act(() => {
      interactionMocks.onHoverOpenChange?.(true)
      interactionMocks.onReviewMenuOpenChange?.(true)
      interactionMocks.onHoverOpenChange?.(false)
    })

    expect(container.querySelector('[data-hover-open]')?.getAttribute('data-hover-open')).toBe(
      'true'
    )
  })

  it('closes the hover after the review menu dismisses a deferred close', () => {
    renderHover()

    act(() => {
      interactionMocks.onHoverOpenChange?.(true)
      interactionMocks.onReviewMenuOpenChange?.(true)
      interactionMocks.onHoverOpenChange?.(false)
      interactionMocks.onReviewMenuOpenChange?.(false)
    })

    expect(container.querySelector('[data-hover-open]')?.getAttribute('data-hover-open')).toBe(
      'false'
    )
  })

  it('suppresses the tooltip while the review menu is open', () => {
    renderHover()

    act(() => {
      interactionMocks.onReviewMenuOpenChange?.(true)
    })

    expect(container.querySelector('[data-tooltip-open]')?.getAttribute('data-tooltip-open')).toBe(
      'false'
    )
  })

  it('invokes unlink and closes the hover from the menu item', () => {
    const onUnlinkReview = renderHover()

    act(() => {
      interactionMocks.onHoverOpenChange?.(true)
      interactionMocks.onReviewMenuOpenChange?.(true)
    })

    const unlinkButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Unlink PR')
    )

    act(() => {
      unlinkButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onUnlinkReview).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-hover-open]')?.getAttribute('data-hover-open')).toBe(
      'false'
    )
    expect(
      container.querySelector('[data-review-menu-open]')?.getAttribute('data-review-menu-open')
    ).toBe('false')
  })
})
