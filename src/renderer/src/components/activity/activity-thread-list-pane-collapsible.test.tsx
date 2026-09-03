// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityStatusGroupHeader } from './activity-thread-controls'
import { ActivityThreadListPane } from './activity-thread-list-pane'
import type { ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mockThread: AgentPaneThread = {
  paneKey: 'tab-1:agent-1',
  tab: makeTab(),
  worktree: makeWorktree(),
  repo: null,
  currentAgentState: null,
  currentAgentEntry: null,
  latestEvent: null,
  latestTimestamp: 1000,
  agentType: 'claude',
  unread: false,
  paneTitle: 'Test agent',
  responsePreview: 'Done testing',
  events: []
}

const mockGroup: ActivityThreadGroup = {
  key: 'done',
  label: 'Done',
  state: 'done',
  threads: [mockThread]
}

describe('ActivityStatusGroupHeader', () => {
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

  it('renders group label, count, and expanded state', () => {
    const onToggle = vi.fn()
    act(() => {
      root.render(
        <TooltipProvider>
          <ActivityStatusGroupHeader group={mockGroup} collapsed={false} onToggle={onToggle} />
        </TooltipProvider>
      )
    })

    const header = container.querySelector('[role="button"]')
    expect(header).not.toBeNull()
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(header?.textContent).toContain('Done')
    expect(header?.textContent).toContain('1')
  })

  it('triggers onToggle on click and on keydown (Enter / Space)', () => {
    const onToggle = vi.fn()
    act(() => {
      root.render(
        <TooltipProvider>
          <ActivityStatusGroupHeader group={mockGroup} collapsed={false} onToggle={onToggle} />
        </TooltipProvider>
      )
    })

    const header = container.querySelector('[role="button"]') as HTMLElement
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onToggle).toHaveBeenCalledTimes(1)

    act(() => {
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onToggle).toHaveBeenCalledTimes(2)

    act(() => {
      header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    expect(onToggle).toHaveBeenCalledTimes(3)
  })

  it('renders collapsed state with aria-expanded false', () => {
    const onToggle = vi.fn()
    act(() => {
      root.render(
        <TooltipProvider>
          <ActivityStatusGroupHeader group={mockGroup} collapsed={true} onToggle={onToggle} />
        </TooltipProvider>
      )
    })

    const header = container.querySelector('[role="button"]')
    expect(header?.getAttribute('aria-expanded')).toBe('false')
  })

  it('supports custom className and uses accessible contrast tokens without hardcoded white background', () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <ActivityStatusGroupHeader
            group={mockGroup}
            collapsed={false}
            className="custom-header-class"
          />
        </TooltipProvider>
      )
    })

    const header = container.querySelector('div')
    expect(header?.className).toContain('custom-header-class')
    expect(header?.className).not.toContain('bg-background/95')
  })
})

describe('ActivityThreadListPane collapsible sections', () => {
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

  it('toggles thread visibility when header is clicked in uncontrolled mode', () => {
    const inputRef = { current: null }
    act(() => {
      root.render(
        <TooltipProvider>
          <ActivityThreadListPane
            activityFilterInputRef={inputRef}
            query=""
            onQueryChange={vi.fn()}
            groupBy="status"
            onGroupByChange={vi.fn()}
            readFilter="all"
            onReadFilterChange={vi.fn()}
            compactMode={false}
            hasUnreadThreads={false}
            onCompactModeChange={vi.fn()}
            onMarkAllThreadsRead={vi.fn()}
            visibleThreadGroups={[mockGroup]}
            visibleThreadCount={1}
            selectedPaneKey={null}
            onSelectThread={vi.fn()}
            onJumpToWorkspace={vi.fn()}
            onMarkThreadRead={vi.fn()}
            onMarkThreadUnread={vi.fn()}
            canJumpToWorkspace={() => true}
            showFilterControls={false}
            showOptionsMenu={false}
          />
        </TooltipProvider>
      )
    })

    // Initially open: thread row should be visible
    expect(container.textContent).toContain('Test agent')

    // Click header to collapse
    const header = container.querySelector('[role="button"]') as HTMLElement
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Thread row should now be hidden
    expect(container.textContent).not.toContain('Test agent')
    expect(header.getAttribute('aria-expanded')).toBe('false')

    // Click header again to re-expand
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Test agent')
    expect(header.getAttribute('aria-expanded')).toBe('true')
  })

  it('respects controlled collapsedGroupKeys and invokes onToggleGroupCollapse', () => {
    const inputRef = { current: null }
    const onToggleGroup = vi.fn()
    act(() => {
      root.render(
        <TooltipProvider>
          <ActivityThreadListPane
            activityFilterInputRef={inputRef}
            query=""
            onQueryChange={vi.fn()}
            groupBy="status"
            onGroupByChange={vi.fn()}
            readFilter="all"
            onReadFilterChange={vi.fn()}
            compactMode={false}
            hasUnreadThreads={false}
            onCompactModeChange={vi.fn()}
            onMarkAllThreadsRead={vi.fn()}
            visibleThreadGroups={[mockGroup]}
            visibleThreadCount={1}
            selectedPaneKey={null}
            onSelectThread={vi.fn()}
            onJumpToWorkspace={vi.fn()}
            onMarkThreadRead={vi.fn()}
            onMarkThreadUnread={vi.fn()}
            canJumpToWorkspace={() => true}
            showFilterControls={false}
            showOptionsMenu={false}
            collapsedGroupKeys={new Set(['done'])}
            onToggleGroupCollapse={onToggleGroup}
          />
        </TooltipProvider>
      )
    })

    // Controlled as collapsed: thread row should not be rendered
    expect(container.textContent).not.toContain('Test agent')

    // Click header
    const header = container.querySelector('[role="button"]') as HTMLElement
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onToggleGroup).toHaveBeenCalledWith('done')
  })

  it('keeps mark-unread enabled for the thread whose terminal pane is selected', () => {
    const inputRef = { current: null }
    const onMarkThreadUnread = vi.fn()
    act(() => {
      root.render(
        <TooltipProvider>
          <ActivityThreadListPane
            activityFilterInputRef={inputRef}
            query=""
            onQueryChange={vi.fn()}
            groupBy="status"
            onGroupByChange={vi.fn()}
            readFilter="all"
            onReadFilterChange={vi.fn()}
            compactMode={false}
            hasUnreadThreads={false}
            onCompactModeChange={vi.fn()}
            onMarkAllThreadsRead={vi.fn()}
            visibleThreadGroups={[mockGroup]}
            visibleThreadCount={1}
            selectedPaneKey={mockThread.paneKey}
            onSelectThread={vi.fn()}
            onJumpToWorkspace={vi.fn()}
            onMarkThreadRead={vi.fn()}
            onMarkThreadUnread={onMarkThreadUnread}
            canJumpToWorkspace={() => true}
            allowMarkUnreadWhenSelected
            showFilterControls={false}
            showOptionsMenu={false}
          />
        </TooltipProvider>
      )
    })

    const markUnreadButton = container.querySelector(
      'button[aria-label="Mark thread unread"]'
    ) as HTMLButtonElement | null
    expect(markUnreadButton).not.toBeNull()
    expect(markUnreadButton?.disabled).toBe(false)

    act(() => {
      markUnreadButton?.click()
    })
    expect(onMarkThreadUnread).toHaveBeenCalledWith(mockThread)
  })
})
