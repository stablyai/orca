// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import AgentDashboardSidebarHost from './AgentDashboardSidebarHost'

vi.mock('@/components/dashboard/AgentDashboardDrawer', () => ({
  AgentDashboardDrawer: () => null
}))

const initialState = useAppStore.getInitialState()

function hostElement(): React.JSX.Element {
  return (
    <AgentDashboardSidebarHost
      sidebarOpen
      workspaceBoardOpen={false}
      closeWorkspaceBoard={vi.fn()}
      statusBarVisible
    />
  )
}

function renderHost(): ReturnType<typeof render> {
  return render(hostElement())
}

beforeEach(() => {
  useAppStore.setState({ agentDashboardDrawerOpen: false }, false)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('AgentDashboardSidebarHost', () => {
  it('closes the dashboard when the workspace board opens', async () => {
    useAppStore.setState({ agentDashboardDrawerOpen: true })
    render(
      <AgentDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen
        closeWorkspaceBoard={vi.fn()}
        statusBarVisible
      />
    )

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  it('closes the workspace board when the dashboard opens', async () => {
    const closeWorkspaceBoard = vi.fn()
    const view = render(
      <AgentDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen={false}
        closeWorkspaceBoard={closeWorkspaceBoard}
        statusBarVisible
      />
    )

    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    view.rerender(
      <AgentDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen={false}
        closeWorkspaceBoard={closeWorkspaceBoard}
        statusBarVisible
      />
    )

    await waitFor(() => expect(closeWorkspaceBoard).toHaveBeenCalledOnce())
  })

  it('yields to the worktree the user switches to', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-a' })
    renderHost()
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))

    act(() => useAppStore.setState({ activeWorktreeId: 'wt-b' }))

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  it('yields to the tab the user switches to', async () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-a',
      activeGroupIdByWorktree: { 'wt-a': 'group-1' },
      groupsByWorktree: {
        'wt-a': [
          {
            id: 'group-1',
            worktreeId: 'wt-a',
            activeTabId: 'tab-1',
            tabOrder: ['tab-1', 'tab-2']
          }
        ]
      }
    })
    renderHost()
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))

    act(() =>
      useAppStore.setState({
        groupsByWorktree: {
          'wt-a': [
            {
              id: 'group-1',
              worktreeId: 'wt-a',
              activeTabId: 'tab-2',
              tabOrder: ['tab-1', 'tab-2']
            }
          ]
        }
      })
    )

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  it('stays open when the active tab closes on its own', async () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-a',
      activeGroupIdByWorktree: { 'wt-a': 'group-1' },
      groupsByWorktree: {
        'wt-a': [
          {
            id: 'group-1',
            worktreeId: 'wt-a',
            activeTabId: 'tab-1',
            tabOrder: ['tab-1', 'tab-2']
          }
        ]
      }
    })
    renderHost()
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))

    // A pty-exit close drops the tab and re-selects a neighbor without user input.
    act(() =>
      useAppStore.setState({
        groupsByWorktree: {
          'wt-a': [
            {
              id: 'group-1',
              worktreeId: 'wt-a',
              activeTabId: 'tab-2',
              tabOrder: ['tab-2']
            }
          ]
        }
      })
    )

    await act(async () => {})
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
  })

  it('stays open when the last tab closes on its own and deactivates the worktree', async () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-a',
      activeGroupIdByWorktree: { 'wt-a': 'group-1' },
      groupsByWorktree: {
        'wt-a': [{ id: 'group-1', worktreeId: 'wt-a', activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      }
    })
    renderHost()
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))

    act(() =>
      useAppStore.setState({
        activeWorktreeId: null,
        groupsByWorktree: {
          'wt-a': [{ id: 'group-1', worktreeId: 'wt-a', activeTabId: null, tabOrder: [] }]
        }
      })
    )

    await act(async () => {})
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
  })

  it('yields when the active worktree is deleted', async () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-a',
      activeGroupIdByWorktree: { 'wt-a': 'group-1' },
      groupsByWorktree: {
        'wt-a': [{ id: 'group-1', worktreeId: 'wt-a', activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      }
    })
    renderHost()
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))

    act(() =>
      useAppStore.setState({
        activeWorktreeId: null,
        activeGroupIdByWorktree: {},
        groupsByWorktree: {}
      })
    )

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  it('yields when the user leaves a worktree whose tab is still open', async () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-a',
      activeGroupIdByWorktree: { 'wt-a': 'group-1' },
      groupsByWorktree: {
        'wt-a': [{ id: 'group-1', worktreeId: 'wt-a', activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      }
    })
    renderHost()
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))

    act(() => useAppStore.setState({ activeWorktreeId: 'wt-b' }))

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  it('stays open when opened over the current worktree', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-a' })
    const view = renderHost()

    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    view.rerender(hostElement())

    await act(async () => {})
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
  })

  it('clears an open dashboard when the sidebar closes', async () => {
    useAppStore.setState({ agentDashboardDrawerOpen: true })
    render(
      <AgentDashboardSidebarHost
        sidebarOpen={false}
        workspaceBoardOpen={false}
        closeWorkspaceBoard={vi.fn()}
        statusBarVisible
      />
    )

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })
})
