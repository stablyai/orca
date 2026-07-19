import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

const mocks = vi.hoisted(() => ({
  status: 'active'
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => (
    <span data-test-status-tooltip="">{children}</span>
  ),
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

  it('gives a passive status lane exactly one tooltip owner by default', () => {
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

    expect(markup.match(/data-test-status-tooltip=""/g)).toHaveLength(1)
  })

  it.each([
    ['activity', null, false, 'Active', 'bg-status-success'],
    ['review', review, false, 'PR checks: Failed', 'text-rose-500/85'],
    ['branch', null, true, 'Branch', 'lucide-git-branch']
  ] as const)(
    'keeps the passive %s glyph and sr-only label when the parent owns hover details',
    (_lane, prDisplay, hasBranchIdentity, label, glyphClassName) => {
      const markup = renderToStaticMarkup(
        <WorktreeCardStatusSlot
          worktreeId="wt-1"
          showStatus
          showUnreadAction={false}
          isUnread={false}
          unreadTooltip="Mark as unread"
          onPointerDown={vi.fn()}
          onToggleUnread={vi.fn()}
          prDisplay={prDisplay}
          newCardStyle
          hasBranchIdentity={hasBranchIdentity}
          statusTooltipEnabled={false}
        />
      )

      expect(markup).not.toContain('data-test-status-tooltip=""')
      expect(markup).toContain(glyphClassName)
      expect(markup).toContain(`<span class="sr-only">${label}</span>`)
    }
  )

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
    expect(markup).not.toContain('bg-status-success')
    expect(markup).toContain('text-status-attention')
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
    expect(markup).toContain('bg-status-attention')
    expect(markup).toContain('ring-worktree-sidebar')
    expect(markup).toContain('bg-status-success')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-status-attention')
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
    expect(markup).toContain('border-status-working')
    expect(markup).not.toContain('data-worktree-status-lane-unread=""')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-status-attention')
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

    expect(markup).toContain('Needs attention · Unread')
    expect(markup).toContain('bg-status-attention')
    expect(markup).not.toContain('data-worktree-status-lane-unread=""')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
  })

  it('keeps a blocked status destructive without adding an unread badge', () => {
    mocks.status = 'blocked'
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

    expect(markup).toContain('Blocked · Unread')
    expect(markup).toContain('bg-destructive')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('bg-status-attention')
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
    expect(markup).toContain('text-status-attention')
    expect(markup).not.toContain('border-status-working')
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
    expect(markup).toContain('bg-status-success')
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
    expect(markup).toContain('bg-status-success')
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
    expect(markup).toContain('size-[13px] translate-x-px')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).not.toContain('bg-status-success')
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

    expect(markup).toContain('MR checks: Pending')
    expect(markup).toContain('viewBox="0 0 16 16"')
    expect(markup).toContain('size-[13px] translate-x-px')
    expect(markup).toContain('text-amber-500/85')
    expect(markup).not.toContain('lucide-git-merge')
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
    expect(markup).not.toContain('bg-status-success')
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
    expect(markup).not.toContain('bg-muted-foreground')
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

    expect(markup).toContain('Branch')
    expect(markup).not.toContain('Branch or folder path')
    expect(markup).toContain('lucide-git-branch')
    expect(markup).toContain('size-[13px] translate-x-px text-muted-foreground/70')
    expect(markup).toContain('text-muted-foreground/70')
    expect(markup).not.toContain('bg-status-success')
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
    expect(markup).toContain('bg-status-success')
    expect(markup).not.toContain('lucide-git-branch')
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
    expect(markup).toContain('inline-flex shrink-0 items-center justify-center size-5')
    expect(markup).toContain('border-status-working')
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

    expect(markup).toContain('Needs attention')
    expect(markup).toContain('bg-status-attention')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it.each([
    ['review', review, false, 'PR checks: Failed'],
    ['branch', null, true, 'lucide-git-branch']
  ] as const)(
    'keeps interrupted ahead of %s identity',
    (_lane, prDisplay, hasBranchIdentity, hidden) => {
      mocks.status = 'interrupted'
      const markup = renderToStaticMarkup(
        <WorktreeCardStatusSlot
          worktreeId="wt-1"
          showStatus
          showUnreadAction={false}
          isUnread={false}
          unreadTooltip="Mark as unread"
          onPointerDown={vi.fn()}
          onToggleUnread={vi.fn()}
          prDisplay={prDisplay}
          newCardStyle
          hasBranchIdentity={hasBranchIdentity}
        />
      )

      expect(markup).toContain('Interrupted')
      expect(markup).toContain('bg-destructive')
      expect(markup).not.toContain(hidden)
    }
  )

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
    expect(markup).not.toContain('bg-status-success')
    expect(markup).toContain('text-status-attention')
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
    expect(markup).toContain('PR checks: Failed · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).toContain('bg-status-attention')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-status-attention')
    expect(markup).not.toContain('bg-status-success')
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

    expect(markup).toContain('Branch · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('Mark as read')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('lucide-git-branch')
    expect(markup).toContain('bg-status-attention')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-status-attention')
    expect(markup).not.toContain('bg-status-success')
  })
})
