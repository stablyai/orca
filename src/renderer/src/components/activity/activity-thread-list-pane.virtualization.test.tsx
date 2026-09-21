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

  function mountedRowCount(): number {
    return container.querySelectorAll('[data-worktree-card-surface="true"]').length
  }

  it('mounts a viewport-bounded number of rows, not one per thread', () => {
    renderPane(root, { threads: makeManyThreads() })
    const mounted = mountedRowCount()
    expect(mounted).toBeGreaterThan(0)
    // Viewport (600px fallback) / ~96px rows + 2x overscan(8); far below THREAD_COUNT.
    expect(mounted).toBeLessThanOrEqual(40)
    // Off-screen rows are not in the DOM at all.
    expect(container.textContent).not.toContain('Virtual agent 250')
  })

  it('keeps the selected off-screen row mounted so activation stays accessible', () => {
    renderPane(root, {
      threads: makeManyThreads(),
      selectedPaneKey: 'tab-250:leaf-250'
    })
    const selected = container.querySelector('[data-worktree-card-active="primary"]')
    expect(selected).not.toBeNull()
    expect(selected?.textContent).toContain('Virtual agent 250')
    // Still virtualized: pinning the selection must not mount the rest of the list.
    expect(mountedRowCount()).toBeLessThanOrEqual(41)
  })

  it('does not mount an off-screen row when its thread data updates', () => {
    const threads = makeManyThreads()
    renderPane(root, { threads })
    const before = mountedRowCount()

    const updated = [...threads]
    updated[250] = { ...threads[250], paneTitle: 'Virtual agent 250 UPDATED', unread: true }
    renderPane(root, { threads: updated })

    expect(container.textContent).not.toContain('Virtual agent 250 UPDATED')
    expect(mountedRowCount()).toBe(before)
  })

  it('renders every row for a short list', () => {
    renderPane(root, { threads: [makeThread(0), makeThread(1), makeThread(2)] })
    expect(mountedRowCount()).toBe(3)
    expect(container.textContent).toContain('Virtual agent 0')
    expect(container.textContent).toContain('Virtual agent 2')
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

  it('restores caller-held collapse state across remounts', () => {
    // Models the sidebar: the caller owns the Set and provides it via context.
    let collapsed: ReadonlySet<string> = new Set<string>()
    const collapseState = (): ActivityThreadCollapseState => ({
      collapsedGroupKeys: collapsed,
      onToggleGroupCollapse: (groupKey: string) => {
        const next = new Set(collapsed)
        if (next.has(groupKey)) {
          next.delete(groupKey)
        } else {
          next.add(groupKey)
        }
        collapsed = next
      }
    })
    renderPane(root, { threads: makeManyThreads(), collapseState: collapseState() })
    const header = container.querySelector('[role="button"]') as HTMLElement
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    renderPane(root, { threads: makeManyThreads(), collapseState: collapseState() })
    expect(container.querySelector('[role="button"]')?.getAttribute('aria-expanded')).toBe('false')

    act(() => root.unmount())
    root = createRoot(container)
    renderPane(root, { threads: makeManyThreads(), collapseState: collapseState() })
    const remountedHeader = container.querySelector('[role="button"]')
    expect(remountedHeader?.getAttribute('aria-expanded')).toBe('false')
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

  it('restores the Agents scroll position without storing it in React state', () => {
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
