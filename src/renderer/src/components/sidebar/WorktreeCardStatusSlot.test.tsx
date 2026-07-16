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
  const gitlabReview: WorktreeCardPrDisplay = {
    provider: 'gitlab',
    number: 456,
    title: 'Review me',
    state: 'open',
    status: 'pending'
  }
  const openReview: WorktreeCardPrDisplay = {
    provider: 'github',
    number: 789,
    title: 'Open review',
    state: 'open'
  }
  const mergedReview: WorktreeCardPrDisplay = {
    provider: 'github',
    number: 790,
    title: 'Merged review',
    state: 'merged',
    status: 'success'
  }

  it('lets the unread bell replace the visual status dot by default', () => {
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
    expect(markup).toContain('text-amber-500')
  })

  it('overlays an unread badge on the status dot when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity={false}
      />
    )

    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('Mark as read')
    expect(markup).toContain('Active · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).toContain('data-worktree-activity-status="active"')
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('keeps working and unread independently visible in the new-card lane', () => {
    mocks.status = 'working'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity={false}
      />
    )

    expect(markup).toContain('Working · Unread')
    expect(markup).toContain('data-worktree-activity-status="working"')
    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('keeps permission and unread independently visible in the new-card lane', () => {
    mocks.status = 'permission'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity={false}
      />
    )

    expect(markup).toContain('Needs permission · Unread')
    expect(markup).toContain('data-worktree-activity-status="permission"')
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
  })

  it('keeps legacy unread working cards on the unread bell control', () => {
    mocks.status = 'working'
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
    expect(markup).toContain('Working')
    expect(markup).toContain('text-amber-500')
    expect(markup).not.toContain('border-yellow-500')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
  })

  it('shows status in the unread toggle affordance', () => {
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

  it('composes active activity with failed PR status in the new-card lane', () => {
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

    expect(markup).toContain('Active · PR checks: Failed')
    expect(markup).toContain('data-worktree-activity-status="active"')
    expect(markup).toContain('data-worktree-review-status=""')
    expect(markup).toContain('grid-cols-2')
    expect(markup).toContain('size-2.5')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).toContain('bg-emerald-500')
  })

  it('uses the unified compact review glyph for GitLab MR status', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={gitlabReview}
        newCardStyle
      />
    )

    expect(markup).toContain('Active · MR checks: Pending')
    expect(markup).toContain('viewBox="0 0 16 16"')
    expect(markup).toContain('data-worktree-activity-status="active"')
    expect(markup).toContain('data-worktree-review-status=""')
    expect(markup).toContain('size-2.5')
    expect(markup).toContain('text-amber-500/85')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-git-merge')
  })

  it('composes a distinct done check with PR status in the new-card lane', () => {
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

    expect(markup).toContain('Done · PR checks: Failed')
    expect(markup).toContain('data-worktree-activity-status="done"')
    expect(markup).toContain('data-worktree-review-status=""')
    expect(markup).toContain('lucide-circle-check')
    expect(markup).toContain('text-emerald-500')
  })

  it('composes inactive activity with PR status in the new-card lane', () => {
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

    expect(markup).toContain('Inactive · PR checks: Failed')
    expect(markup).toContain('data-worktree-activity-status="inactive"')
    expect(markup).toContain('data-worktree-review-status=""')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).toContain('bg-neutral-500/40')
  })

  it('uses a branch icon with branch-only tooltip copy by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity
      />
    )

    expect(markup).toContain('Active · Branch')
    expect(markup).not.toContain('Branch or folder path')
    expect(markup).toContain('lucide-git-branch')
    expect(markup).toContain('data-worktree-activity-status="active"')
    expect(markup).toContain('data-worktree-branch-status=""')
    expect(markup).toContain('size-2.5 text-muted-foreground/70')
    expect(markup).toContain('text-muted-foreground/70')
    expect(markup).toContain('bg-emerald-500')
  })

  it('uses context-aware branch or folder path tooltip copy', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity
        branchIdentityLabel="Branch or folder path"
      />
    )

    expect(markup).toContain('Active · Branch or folder path')
    expect(markup).toContain('lucide-git-branch')
  })

  it('keeps the quiet dot when the row has no branch identity', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity={false}
      />
    )

    expect(markup).toContain('Active')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-git-branch')
  })

  it('composes working activity with PR status in the new-card lane', () => {
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

    expect(markup).toContain('Working · PR checks: Failed')
    expect(markup).toContain('data-worktree-activity-status="working"')
    expect(markup).toContain('data-worktree-review-status=""')
    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('text-rose-500/85')
  })

  it('composes permission activity with PR status in the new-card lane', () => {
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

    expect(markup).toContain('Needs permission · PR checks: Failed')
    expect(markup).toContain('data-worktree-activity-status="permission"')
    expect(markup).toContain('data-worktree-review-status=""')
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('text-rose-500/85')
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
    expect(markup).not.toContain('Active · Mark as read')
    expect(markup).not.toContain('PR checks: Failed')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).toContain('text-amber-500')
  })

  it('overlays an unread badge on PR status when new card style is on', () => {
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

    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('Mark as read')
    expect(markup).toContain('Active · PR checks: Failed · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('overlays an unread badge on the branch icon in new card style', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity
      />
    )

    expect(markup).toContain('Active · Branch · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('Mark as read')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('lucide-git-branch')
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('renders open review state beside active activity', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={openReview}
        newCardStyle
      />
    )

    expect(markup).toContain('Active · PR: Open')
    expect(markup).toContain('data-worktree-activity-status="active"')
    expect(markup).toContain('data-worktree-review-status=""')
    expect(markup).toContain('text-emerald-500/80')
    expect(markup).toContain('bg-emerald-500')
  })

  it('renders merged review state beside the distinct done activity check', () => {
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
        prDisplay={mergedReview}
        newCardStyle
      />
    )

    expect(markup).toContain('Done · PR: Merged')
    expect(markup).toContain('data-worktree-activity-status="done"')
    expect(markup).toContain('data-worktree-review-status=""')
    expect(markup).toContain('lucide-circle-check')
    expect(markup).toContain('text-purple-600/70')
  })
})
