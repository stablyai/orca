// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityThreadListPane } from './activity-thread-list-pane'
import type { ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeThread(name: string): AgentPaneThread {
  return {
    paneKey: `tab-${name}:leaf`,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1000,
    agentType: 'claude',
    unread: false,
    paneTitle: `Agent ${name}`,
    responsePreview: '',
    events: []
  }
}

const a = makeThread('A')
const b = makeThread('B')
const c = makeThread('C')
const d = makeThread('D')
const groups: ActivityThreadGroup[] = [
  { key: 'working', label: 'Working', state: 'working', threads: [a, b] },
  { key: 'done', label: 'Done', state: 'done', threads: [c, d] }
]

let container: HTMLDivElement
let root: Root
let onSelectThread: ReturnType<typeof vi.fn<(thread: AgentPaneThread) => void>>

function renderPane(selectedPaneKey: string | null = null): void {
  act(() => {
    root.render(
      <TooltipProvider>
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
          visibleThreadGroups={groups}
          visibleThreadCount={4}
          selectedPaneKey={selectedPaneKey}
          onSelectThread={onSelectThread}
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
}

function row(thread: AgentPaneThread): HTMLElement {
  const match = Array.from(
    container.querySelectorAll<HTMLElement>('[data-worktree-card-surface]')
  ).find((element) => element.getAttribute('aria-label') === thread.paneTitle)
  if (!match) {
    throw new Error(`row ${thread.paneTitle} is not rendered`)
  }
  return match
}

function click(
  thread: AgentPaneThread,
  modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>> = {}
): void {
  act(() => {
    row(thread).dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers }))
  })
}

function selectedTitles(): string[] {
  return Array.from(container.querySelectorAll('[data-worktree-card-selected]')).map(
    (element) => element.getAttribute('aria-label') ?? ''
  )
}

function setPlatform(isMac: boolean): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    isMac ? 'Mozilla/5.0 (Macintosh)' : 'Mozilla/5.0 (Windows NT 10.0)'
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onSelectThread = vi.fn<(thread: AgentPaneThread) => void>()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('ActivityThreadListPane multi-select', () => {
  it('toggles rows with Ctrl on Windows/Linux without opening them', () => {
    setPlatform(false)
    renderPane()
    click(a, { ctrlKey: true })
    click(c, { ctrlKey: true })

    expect(selectedTitles()).toEqual(['Agent A', 'Agent C'])
    expect(onSelectThread).not.toHaveBeenCalled()
    click(a, { ctrlKey: true })
    expect(selectedTitles()).toEqual(['Agent C'])
  })

  it('toggles with Cmd on macOS and ignores Ctrl-click, the native right-click gesture', () => {
    setPlatform(true)
    renderPane()
    click(a, { metaKey: true })
    click(b, { ctrlKey: true })

    expect(selectedTitles()).toEqual(['Agent A'])
    expect(onSelectThread).not.toHaveBeenCalled()
  })

  it('opens the agent and replaces the selection on a plain click', () => {
    setPlatform(false)
    renderPane()
    click(a, { ctrlKey: true })
    click(c, { ctrlKey: true })
    click(b)

    expect(onSelectThread).toHaveBeenCalledWith(b)
    expect(selectedTitles()).toEqual(['Agent B'])
  })

  it('selects a Shift range across group headers', () => {
    setPlatform(false)
    renderPane()
    click(b)
    click(d, { shiftKey: true })

    expect(selectedTitles()).toEqual(['Agent B', 'Agent C', 'Agent D'])
    expect(onSelectThread).toHaveBeenCalledTimes(1)
  })

  it('never marks the open row as selected, so it keeps its active look', () => {
    setPlatform(false)
    renderPane(b.paneKey)
    click(a, { ctrlKey: true })
    click(b, { ctrlKey: true })

    expect(selectedTitles()).toEqual(['Agent A'])
    expect(row(b).getAttribute('data-worktree-card-active')).toBe('primary')
  })

  it('drops rows hidden by a collapsed group from the selection', () => {
    setPlatform(false)
    renderPane()
    click(a, { ctrlKey: true })
    click(c, { ctrlKey: true })

    const doneHeader = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes('Done')
    )
    act(() => doneHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => doneHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(selectedTitles()).toEqual(['Agent A'])
  })
})
