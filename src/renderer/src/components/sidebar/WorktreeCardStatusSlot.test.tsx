import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'

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
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('suppresses the new-card unread badge while unread status is working', () => {
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
    expect(markup).toContain('border-yellow-500')
    expect(markup).not.toContain('data-worktree-status-lane-unread=""')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('suppresses the new-card unread badge while unread status is permission', () => {
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
    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-amber-500')
    expect(markup).not.toContain('data-worktree-status-lane-unread=""')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
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

  it('keeps the emerald activity dot ahead of branch identity when new card style is on', () => {
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

    expect(markup).toContain('Active')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-git-branch')
  })

  it('shows done activity in new card style', () => {
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
        newCardStyle
      />
    )

    expect(markup).toContain('Done')
    expect(markup).toContain('bg-emerald-500')
  })

  it('uses a branch icon with branch-only tooltip copy on quiet rows', () => {
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
        newCardStyle
        hasBranchIdentity
      />
    )

    expect(markup).toContain('Branch')
    expect(markup).not.toContain('Branch or folder path')
    expect(markup).toContain('lucide-git-branch')
    expect(markup).toContain('size-[13px] translate-x-px text-muted-foreground/70')
    expect(markup).toContain('text-muted-foreground/70')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('uses context-aware branch or folder path tooltip copy', () => {
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
        newCardStyle
        hasBranchIdentity
        branchIdentityLabel="Branch or folder path"
      />
    )

    expect(markup).toContain('Branch or folder path')
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

  it('shows working activity in new card style', () => {
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
        newCardStyle
      />
    )

    expect(markup).toContain('Working')
    expect(markup).toContain('inline-flex size-5 items-center justify-center')
    expect(markup).toContain('border-yellow-500')
  })

  it('shows permission activity in new card style', () => {
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
        newCardStyle
      />
    )

    expect(markup).toContain('Needs permission')
    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-amber-500')
  })

  it('overlays an unread badge on the branch icon in new card style', () => {
    mocks.status = 'inactive'
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

    expect(markup).toContain('Branch · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('Mark as read')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('lucide-git-branch')
    expect(markup).toContain('bg-amber-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('bg-emerald-500')
  })
})
