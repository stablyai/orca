import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const mocks = vi.hoisted(() => ({ status: 'permission' as WorktreeStatus }))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => mocks.status
}))

function render(props: { isUnread: boolean; showStatus?: boolean; unreadTooltip: string }): string {
  return renderToStaticMarkup(
    <WorktreeCardStatusSlot
      worktreeId="wt-1"
      showStatus={props.showStatus ?? true}
      showUnreadAction
      isUnread={props.isUnread}
      unreadTooltip={props.unreadTooltip}
      onPointerDown={vi.fn()}
      onToggleUnread={vi.fn()}
    />
  )
}

describe('WorktreeCardStatusSlot', () => {
  beforeEach(() => {
    mocks.status = 'permission'
  })

  it('shows a green dot — not the amber bell — when a finished agent is unread', () => {
    mocks.status = 'done'
    const markup = render({ isUnread: true, showStatus: false, unreadTooltip: 'Mark as read' })

    expect(markup).toContain('bg-status-success')
    expect(markup).not.toContain('text-amber-500')
  })

  it('shows the amber bell when an unread worktree needs the user input', () => {
    mocks.status = 'permission'
    const markup = render({ isUnread: true, showStatus: false, unreadTooltip: 'Mark as read' })

    expect(markup).toContain('text-amber-500')
    expect(markup).not.toContain('bg-status-success')
  })

  it('shows a green dot for non-input unread pings (raw terminal BEL)', () => {
    mocks.status = 'active'
    const markup = render({ isUnread: true, showStatus: false, unreadTooltip: 'Mark as read' })

    expect(markup).toContain('bg-status-success')
    expect(markup).not.toContain('text-amber-500')
  })

  it('lets the unread indicator replace the visual status dot', () => {
    mocks.status = 'permission'
    const markup = render({ isUnread: true, unreadTooltip: 'Mark as read' })

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).not.toContain('Needs permission · Mark as read')
    expect(markup).not.toContain('bg-status-warning')
  })

  it('shows the live status dot until an unread indicator is active', () => {
    mocks.status = 'permission'
    const markup = render({ isUnread: false, unreadTooltip: 'Mark as unread' })

    expect(markup).toContain('Needs permission · Mark as unread')
    expect(markup).toContain('bg-status-warning')
  })
})
