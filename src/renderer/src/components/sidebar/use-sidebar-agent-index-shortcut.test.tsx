// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivityThreadCollapseContext } from '@/components/activity/activity-thread-collapse-context'
import { makeTab, makeWorktree } from '@/components/activity/ActivityPrototypePage-test-fixtures'
import type {
  ActivityThreadGroup,
  AgentPaneThread
} from '@/components/activity/activity-thread-types'
import {
  SIDEBAR_AGENT_INDEX_JUMP_EVENT,
  useSidebarAgentIndexShortcut
} from './use-sidebar-agent-index-shortcut'

const thread = (paneKey: string): AgentPaneThread => ({
  paneKey,
  tab: makeTab(),
  worktree: makeWorktree(),
  repo: null,
  currentAgentState: null,
  currentAgentEntry: null,
  latestEvent: null,
  latestTimestamp: 1000,
  agentType: 'claude',
  unread: false,
  paneTitle: paneKey,
  responsePreview: '',
  events: []
})
const collapse = { collapsedGroupKeys: new Set(['one']), onToggleGroupCollapse: vi.fn() }
const first = thread('first')
const second = thread('second')
const third = thread('third')
const groups: ActivityThreadGroup[] = [
  { key: 'one', label: 'One', threads: [first, third] },
  { key: 'two', label: 'Two', threads: [second] }
]
const jump = (index: number): void => {
  act(() => {
    window.dispatchEvent(new CustomEvent(SIDEBAR_AGENT_INDEX_JUMP_EVENT, { detail: index }))
  })
}
afterEach(cleanup)

it('follows rendered group order, skips headers, and refreshes after filtering', () => {
  const select = vi.fn()
  const view = renderHook(({ rows }) => useSidebarAgentIndexShortcut(rows, 'project', select), {
    initialProps: { rows: groups }
  })
  jump(0)
  jump(1)
  jump(2)
  expect(select.mock.calls.map(([row]) => row)).toEqual([first, third, second])
  view.rerender({ rows: [groups[1]] })
  jump(0)
  expect(select).toHaveBeenLastCalledWith(second)
  select.mockClear()
  for (const index of [-1, 1, 9, 0.5, Number.NaN]) {
    jump(index)
  }
  expect(select).not.toHaveBeenCalled()
  view.unmount()
  jump(0)
  expect(select).not.toHaveBeenCalled()
})

it('honors the sidebar collapse context without renumbering by scroll position', () => {
  const select = vi.fn()
  renderHook(() => useSidebarAgentIndexShortcut(groups, 'project', select), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ActivityThreadCollapseContext.Provider value={collapse}>
        {children}
      </ActivityThreadCollapseContext.Provider>
    )
  })
  jump(0)
  jump(1)
  expect(select).toHaveBeenCalledExactlyOnceWith(second)
})

it('ignores saved collapsed groups when grouping is disabled and handles an empty list', () => {
  const select = vi.fn()
  const view = renderHook(({ rows }) => useSidebarAgentIndexShortcut(rows, 'none', select), {
    initialProps: { rows: groups },
    wrapper: ({ children }: { children: ReactNode }) => (
      <ActivityThreadCollapseContext.Provider value={collapse}>
        {children}
      </ActivityThreadCollapseContext.Provider>
    )
  })
  jump(0)
  expect(select).toHaveBeenCalledExactlyOnceWith(first)
  select.mockClear()
  view.rerender({ rows: [] })
  jump(0)
  expect(select).not.toHaveBeenCalled()
})
