// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import SidebarAgentsList from './SidebarAgentsList'
import {
  makeRepo,
  makeWorktree,
  makeTab,
  makeRetainedDoneEntry,
  makeWorkingEntryWithoutHistory,
  PANE_KEY,
  PANE_KEY_2
} from '@/components/activity/ActivityPrototypePage-test-fixtures'

const initialState = useAppStore.getState()

vi.mock('@/components/activity/activity-thread-list-pane', () => ({
  ActivityThreadListPane: () => null
}))

beforeEach(() => {
  useAppStore.setState({ agentsShowSearch: true })
  vi.stubGlobal('api', { ui: { set: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState)
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('preserves workspace focus on mount and focuses search only when explicitly enabled', async () => {
  const workspaceInput = document.createElement('input')
  const optionsTarget = document.createElement('div')
  document.body.append(workspaceInput, optionsTarget)
  workspaceInput.focus()
  const setQuery = vi.fn()
  const view = render(
    <TooltipProvider>
      <SidebarAgentsList
        readFilter="all"
        setReadFilter={vi.fn()}
        groupBy="status"
        setGroupBy={vi.fn()}
        query=""
        setQuery={setQuery}
        optionsTarget={optionsTarget}
      />
    </TooltipProvider>
  )

  expect(view.getByRole('textbox', { name: 'Search' })).toBeTruthy()
  expect(document.activeElement).toBe(workspaceInput)

  fireEvent.keyDown(view.getByRole('textbox', { name: 'Search' }), { key: 'Escape' })
  expect(useAppStore.getState().agentsShowSearch).toBe(false)
  expect(setQuery).toHaveBeenCalledWith('')
  expect(view.queryByRole('textbox', { name: 'Search' })).toBeNull()

  await act(async () => {
    fireEvent.keyDown(view.getByRole('button', { name: 'Thread list options' }), { key: 'Enter' })
  })
  await act(async () => {
    fireEvent.keyDown(view.getByRole('menuitemcheckbox', { name: 'Show search' }), { key: 'Enter' })
  })
  await waitFor(() => {
    expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'Search' }))
  })
  expect(useAppStore.getState().agentsShowSearch).toBe(true)
  expect(window.api.ui.set).toHaveBeenCalledWith({ agentsShowSearch: false })
  expect(window.api.ui.set).toHaveBeenCalledWith({ agentsShowSearch: true })
})

it('keeps filtered live badge counts across sidebar modes and excludes retained waiting history', () => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000)
  const worktree = makeWorktree()
  const tab = makeTab()
  const retained = makeRetainedDoneEntry({ ...tab, id: 'tab-2' })
  useAppStore.setState({
    repos: [makeRepo(), { ...makeRepo(), id: 'other-repo' }],
    worktreesByRepo: { 'repo-1': [worktree] },
    tabsByWorktree: { 'wt-1': [tab] },
    agentsVisibleHostIds: null,
    agentsFilterRepoIds: [],
    agentsHideWorkspacesFromOtherDevices: false,
    agentsHideAutomationGeneratedWorkspaces: false,
    agentsHideCliCreatedWorkspaces: false,
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        ...makeWorkingEntryWithoutHistory(),
        state: 'waiting',
        updatedAt: 10_000,
        stateStartedAt: 10_000
      }
    },
    retainedAgentsByPaneKey: {
      [PANE_KEY_2]: {
        ...retained,
        entry: { ...retained.entry, paneKey: PANE_KEY_2, state: 'waiting' }
      }
    }
  })
  const badgeTarget = document.createElement('span')
  document.body.append(badgeTarget)
  const props = {
    readFilter: 'all' as const,
    setReadFilter: vi.fn(),
    groupBy: 'status' as const,
    setGroupBy: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    badgeTarget
  }
  const view = render(<SidebarAgentsList {...props} active={false} />)
  expect(badgeTarget.textContent).toBe('1')
  view.rerender(<SidebarAgentsList {...props} active />)
  expect(badgeTarget.textContent).toBe('1')
  act(() => useAppStore.setState({ agentsFilterRepoIds: ['other-repo'] }))
  expect(badgeTarget.textContent).toBe('0')
  view.rerender(<SidebarAgentsList {...props} active={false} />)
  expect(badgeTarget.textContent).toBe('0')
})

it('preserves historical search, live badges and migration blocks in badge-only mode', () => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000)
  const tab = makeTab()
  useAppStore.setState({
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [makeWorktree()] },
    tabsByWorktree: { 'wt-1': [tab] },
    agentsVisibleHostIds: null,
    agentsFilterRepoIds: [],
    agentsHideWorkspacesFromOtherDevices: false,
    agentsHideAutomationGeneratedWorkspaces: false,
    agentsHideCliCreatedWorkspaces: false,
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        ...makeWorkingEntryWithoutHistory(),
        workingMode: 'monitoring',
        updatedAt: 10_000,
        stateStartedAt: 10_000,
        stateHistory: [{ state: 'done', prompt: 'previous-task', startedAt: 1_000 }]
      }
    }
  })
  const badgeTarget = document.createElement('span')
  document.body.append(badgeTarget)
  const props = {
    readFilter: 'unread' as const,
    setReadFilter: vi.fn(),
    groupBy: 'status' as const,
    setGroupBy: vi.fn(),
    query: 'previous-task',
    setQuery: vi.fn(),
    badgeTarget
  }
  const view = render(<SidebarAgentsList {...props} active={false} />)
  expect(badgeTarget.textContent).toBe('1')
  view.rerender(<SidebarAgentsList {...props} active />)
  expect(badgeTarget.textContent).toBe('1')
  act(() => useAppStore.setState({ acknowledgedAgentsByPaneKey: { [PANE_KEY]: 2_000 } }))
  expect(badgeTarget.textContent).toBe('1')
  view.rerender(<SidebarAgentsList {...props} active={false} />)
  expect(badgeTarget.textContent).toBe('1')
  act(() => useAppStore.setState({ agentStatusByPaneKey: {} }))
  view.rerender(<SidebarAgentsList {...props} query="" readFilter="all" active={false} />)
  expect(badgeTarget.textContent).toBe('0')
  act(() =>
    useAppStore.setState({
      migrationUnsupportedByPtyId: {
        'pty-1': {
          ptyId: 'pty-1',
          paneKey: PANE_KEY,
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: 3_000
        }
      }
    })
  )
  expect(badgeTarget.textContent).toBe('1')
  view.rerender(<SidebarAgentsList {...props} query="" readFilter="all" active />)
  expect(badgeTarget.textContent).toBe('1')
})
