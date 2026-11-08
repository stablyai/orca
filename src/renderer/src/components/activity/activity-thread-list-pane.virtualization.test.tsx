// @vitest-environment happy-dom

import { act, type MutableRefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityThreadListPane } from './activity-thread-list-pane'
import {
  ActivityThreadCollapseContext,
  type ActivityThreadCollapseState
} from './activity-thread-collapse-context'
import type { ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const THREAD_COUNT = 300

function makeThread(index: number): AgentPaneThread {
  return {
    paneKey: `tab-${index}:leaf-${index}`,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1_000_000 - index,
    agentType: 'claude',
    unread: false,
    paneTitle: `Virtual agent ${index}`,
    responsePreview: '',
    events: []
  }
}

function makeManyThreads(): AgentPaneThread[] {
  return Array.from({ length: THREAD_COUNT }, (_, index) => makeThread(index))
}

function makeGroups(threads: AgentPaneThread[]): ActivityThreadGroup[] {
  return [{ key: 'done', label: 'Done', state: 'done', threads }]
}

function renderPane(
  root: Root,
  args: {
    threads: AgentPaneThread[]
    selectedPaneKey?: string | null
    scrollTopRef?: MutableRefObject<number>
    collapseState?: ActivityThreadCollapseState
  }
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <ActivityThreadCollapseContext.Provider value={args.collapseState ?? null}>
          <ActivityThreadListPane
            activityFilterInputRef={{ current: null }}
            query=""
            onQueryChange={vi.fn()}
            groupBy="status"
            onGroupByChange={vi.fn()}
            readFilter="all"
            onReadFilterChange={vi.fn()}
            compactMode={true}
            hasUnreadThreads={false}
            onCompactModeChange={vi.fn()}
            onMarkAllThreadsRead={vi.fn()}
            visibleThreadGroups={makeGroups(args.threads)}
            visibleThreadCount={args.threads.length}
            selectedPaneKey={args.selectedPaneKey ?? null}
            onSelectThread={vi.fn()}
            onJumpToWorkspace={vi.fn()}
            onMarkThreadRead={vi.fn()}
            onMarkThreadUnread={vi.fn()}
            onMarkThreadsRead={vi.fn()}
            onMarkThreadsUnread={vi.fn()}
            canJumpToWorkspace={() => true}
            showFilterControls={false}
            showOptionsMenu={false}
            scrollTopRef={args.scrollTopRef}
          />
        </ActivityThreadCollapseContext.Provider>
      </TooltipProvider>
    )
  })
}

describe('ActivityThreadListPane virtualization', () => {
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

  it('keeps the saved scroll offset when the pane mounts before threads hydrate', () => {
    const scrollTopRef = { current: 360 }
    renderPane(root, { threads: [], scrollTopRef })
    const scrollContainer = container.querySelector<HTMLElement>('.overflow-y-auto')
    // Empty list cannot contain the offset: restore is deferred, not clamped to 0.
    act(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = 0
        scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }))
      }
    })
    expect(scrollTopRef.current).toBe(360)

    renderPane(root, { threads: makeManyThreads(), scrollTopRef })
    expect(container.querySelector<HTMLElement>('.overflow-y-auto')?.scrollTop).toBe(360)
  })

  it('disarms a stale deferred restore instead of yanking the viewport on late growth', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const scrollTopRef = { current: 360 }
      // Mounts with a list too small to contain the saved offset (it shrank).
      renderPane(root, { threads: [makeThread(0)], scrollTopRef })
      const scrollContainer = container.querySelector<HTMLElement>('.overflow-y-auto')
      expect(scrollContainer?.scrollTop).toBe(0)

      // Well past the restore window, the list grows beyond the saved offset.
      vi.setSystemTime(1_010_000)
      renderPane(root, { threads: makeManyThreads(), scrollTopRef })

      expect(container.querySelector<HTMLElement>('.overflow-y-auto')?.scrollTop).toBe(0)
      expect(scrollTopRef.current).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores the caller-held Agents scroll position across remounts', () => {
    const scrollTopRef = { current: 240 }
    renderPane(root, { threads: makeManyThreads(), scrollTopRef })
    const scrollContainer = container.querySelector<HTMLElement>('.overflow-y-auto')
    expect(scrollContainer?.scrollTop).toBe(240)

    act(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = 360
        scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }))
      }
    })
    expect(scrollTopRef.current).toBe(360)

    act(() => root.unmount())
    root = createRoot(container)
    renderPane(root, { threads: makeManyThreads(), scrollTopRef })
    expect(container.querySelector<HTMLElement>('.overflow-y-auto')?.scrollTop).toBe(360)
  })
})
