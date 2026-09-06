// @vitest-environment happy-dom

import React, { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Worktree } from '../../../../shared/worktree/types'
import { ActivityThreadHoverCard } from './activity-thread-hover-card'
import { ActivityThreadRow } from './activity-thread-row'
import type { AgentPaneThread } from './activity-thread-types'
import { makeRepo, makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    onOpenChange
  }: {
    children: ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    React.useEffect(() => onOpenChange?.(true), [onOpenChange])
    return <>{children}</>
  },
  HoverCardContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="hover-card-content" className={className}>
      {children}
    </div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function createTestThread(overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
  const repo = makeRepo()
  const worktree: Worktree = {
    ...makeWorktree(),
    displayName: 'm4air-audit',
    branch: 'feat/m4air-performance',
    path: '/Users/test/projects/orca/worktrees/m4air-audit',
    comment: 'Notes for performance audit',
    hostId: 'runtime:m4air-env-id' as const
  }
  const tab = makeTab()

  return {
    paneKey: 'tab-1:leaf-1',
    tab,
    worktree,
    repo,
    agentType: 'claude',
    latestEvent: null,
    currentAgentState: 'working',
    currentAgentEntry: null,
    events: [],
    unread: false,
    paneTitle: 'Audit current HEAD on m4air environment',
    responsePreview: 'Auditing terminal PTY and IME bug categories...',
    latestTimestamp: 1700000000000,
    ...overrides
  }
}

function Harness({
  thread,
  selected = false,
  onSelect = vi.fn(),
  onJump = vi.fn(),
  onMarkRead = vi.fn(),
  onMarkUnread = vi.fn()
}: {
  thread: AgentPaneThread
  selected?: boolean
  onSelect?: () => void
  onJump?: () => void
  onMarkRead?: () => void
  onMarkUnread?: () => void
}): ReactElement {
  return (
    <TooltipProvider>
      <ActivityThreadRow
        thread={thread}
        selected={selected}
        onSelect={onSelect}
        onJump={onJump}
        onMarkRead={onMarkRead}
        onMarkUnread={onMarkUnread}
        canJump={true}
        compactMode={false}
      />
    </TooltipProvider>
  )
}

describe('ActivityThreadHoverCard and ActivityThreadRow', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  it('renders the thread row with task title and workspace label', async () => {
    const thread = createTestThread()

    await act(async () => {
      root.render(<Harness thread={thread} />)
    })

    const card = container.querySelector('[data-worktree-card-surface="true"]')
    expect(card).not.toBeNull()
    expect(card?.getAttribute('role')).toBe('listitem')
    expect(
      card?.querySelector('button[aria-label="Audit current HEAD on m4air environment"]')
    ).not.toBeNull()
    expect(card?.textContent).toContain('Audit current HEAD on m4air environment')
    expect(card?.textContent).toContain('m4air-audit')
  })

  it('marks an unread thread as read from its bell without selecting the row', async () => {
    const thread = createTestThread({ unread: true })
    const onMarkRead = vi.fn()
    const onSelect = vi.fn()

    await act(async () => {
      root.render(<Harness thread={thread} onMarkRead={onMarkRead} onSelect={onSelect} />)
    })

    const markReadButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Mark thread as read"]'
    )
    expect(markReadButton).not.toBeNull()

    act(() => {
      markReadButton?.click()
    })

    expect(onMarkRead).toHaveBeenCalledWith(thread)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders hover card content with workspace info, host, task details, and notes', async () => {
    const thread = createTestThread({
      worktree: {
        ...makeWorktree(),
        displayName: 'm4air-audit',
        branch: 'feat/m4air-performance',
        path: '/Users/test/projects/orca/worktrees/m4air-audit',
        comment: 'Performance investigation notes',
        hostId: 'runtime:m4air-env' as const
      }
    })

    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActivityThreadHoverCard thread={thread}>
            <div data-testid="hover-trigger">Hover Target</div>
          </ActivityThreadHoverCard>
        </TooltipProvider>
      )
    })

    const content = container.querySelector('[data-testid="hover-card-content"]')?.textContent ?? ''

    // Workspace & Host info
    expect(content).toContain('Workspace')
    expect(content).toContain('m4air-audit')
    expect(content).toContain('feat/m4air-performance')
    expect(content).toContain('/Users/test/projects/orca/worktrees/m4air-audit')

    // Agent & Task details
    expect(content).toContain('Claude')
    expect(content).toContain('Audit current HEAD on m4air environment')
    expect(content).toContain('Auditing terminal PTY and IME bug categories...')

    // Notes
    expect(content).toContain('Notes')
    expect(content).toContain('Performance investigation notes')
  })

  it('allows clicking row while preventing inner hover interactions from bubbling', async () => {
    const onSelect = vi.fn()
    const thread = createTestThread()

    await act(async () => {
      root.render(<Harness thread={thread} onSelect={onSelect} />)
    })

    const card = container.querySelector<HTMLElement>('[data-worktree-card-surface="true"]')
    expect(card).not.toBeNull()

    await act(async () => {
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('triggers jump to workspace from the hover card crosshair locator button', async () => {
    const onJump = vi.fn()
    const thread = createTestThread()

    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActivityThreadHoverCard
            thread={thread}
            onJumpToWorkspace={onJump}
            canJumpToWorkspace={true}
          >
            <div data-testid="hover-trigger">Hover Target</div>
          </ActivityThreadHoverCard>
        </TooltipProvider>
      )
    })

    const jumpButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Jump to workspace"]'
    )
    expect(jumpButton).not.toBeNull()

    act(() => {
      jumpButton?.click()
    })

    expect(onJump).toHaveBeenCalledWith(thread)
  })
})
