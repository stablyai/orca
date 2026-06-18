import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

const mocks = vi.hoisted(() => ({
  status: 'active'
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => mocks.status
}))

describe('WorktreeCardStatusSlot', () => {
  beforeEach(() => {
    mocks.status = 'active'
  })

  const review: WorktreeCardPrDisplay = {
    provider: 'github',
    number: 123,
    title: 'Review me',
    state: 'open',
    status: 'failure'
  }

  it('lets the unread bell replace the visual status dot', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).not.toContain('Active · Mark as read')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('shows status until an unread bell is active', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
      />
    )

    expect(markup).toContain('Active · Mark as unread')
    expect(markup).toContain('bg-emerald-500')
  })

  it('keeps the quiet active dot ahead of PR status by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
      />
    )

    expect(markup).toContain('Active')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('uses PR status instead of the quiet active dot when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('PR checks: Failed')
    expect(markup).toContain('inline-flex size-5 items-center justify-center')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('uses PR status instead of the quiet done dot when new card style is on', () => {
    mocks.status = 'done'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('PR checks: Failed')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('uses PR status instead of the inactive dot when new card style is on', () => {
    mocks.status = 'inactive'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('PR checks: Failed')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).not.toContain('bg-neutral-500/40')
  })

  it('keeps working activity ahead of PR status in new card style', () => {
    mocks.status = 'working'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('Working')
    expect(markup).toContain('inline-flex size-5 items-center justify-center')
    expect(markup).toContain('border-yellow-500')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('keeps permission activity ahead of PR status in new card style', () => {
    mocks.status = 'permission'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('Needs permission')
    expect(markup).toContain('bg-amber-500')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('keeps unread ahead of PR status by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).not.toContain('PR checks: Failed')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('overlays unread on PR status instead of replacing it when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).toContain('PR checks: Failed · Mark as read')
    expect(markup).toContain(
      'group/unread relative flex cursor-pointer items-center justify-center rounded transition-all size-5'
    )
    expect(markup).toContain('text-rose-500/85')
    expect(markup).toContain('absolute -right-1 -top-1 size-[13px] text-amber-500')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('keeps the new style unread status dot in the stable lane footprint', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Active · Mark as unread')
    expect(markup).toContain(
      'group/unread relative flex cursor-pointer items-center justify-center rounded transition-all size-5'
    )
  })
})
