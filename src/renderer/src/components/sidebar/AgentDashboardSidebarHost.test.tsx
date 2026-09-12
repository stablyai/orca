// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import AgentDashboardSidebarHost from './AgentDashboardSidebarHost'

vi.mock('@/components/dashboard/AgentDashboardDrawer', () => ({
  AgentDashboardDrawer: () => null
}))

const initialState = useAppStore.getInitialState()

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

  it('yields to the page the user just asked for', async () => {
    const props = {
      sidebarOpen: true,
      workspaceBoardOpen: false,
      closeWorkspaceBoard: vi.fn(),
      statusBarVisible: true
    }
    useAppStore.setState({ activeView: 'terminal', agentDashboardDrawerOpen: true })
    const view = render(<AgentDashboardSidebarHost {...props} />)

    act(() => useAppStore.getState().openAutomationsPage())
    view.rerender(<AgentDashboardSidebarHost {...props} />)

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  // Why: opening the drawer never touches activeView, so a rule keyed on the current view rather
  // than on a change to it would close a drawer opened while standing on one of those pages.
  it('stays open when opened while a page is already showing', async () => {
    const props = {
      sidebarOpen: true,
      workspaceBoardOpen: false,
      closeWorkspaceBoard: vi.fn(),
      statusBarVisible: true
    }
    useAppStore.setState({ activeView: 'automations', agentDashboardDrawerOpen: false })
    const view = render(<AgentDashboardSidebarHost {...props} />)

    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    view.rerender(<AgentDashboardSidebarHost {...props} />)

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true))
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
