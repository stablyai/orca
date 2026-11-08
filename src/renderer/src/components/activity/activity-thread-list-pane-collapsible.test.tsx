// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
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
            onMarkThreadsRead={vi.fn()}
            onMarkThreadsUnread={vi.fn()}
            canJumpToWorkspace={() => true}
            showFilterControls={false}
            showOptionsMenu={false}
          />
        </TooltipProvider>
      )
    })

    expect(container.textContent).toContain('Test agent')

    const header = container.querySelector('[role="button"]') as HTMLElement
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).not.toContain('Test agent')
    expect(header.getAttribute('aria-expanded')).toBe('false')

    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Test agent')
    expect(header.getAttribute('aria-expanded')).toBe('true')
  })
})
