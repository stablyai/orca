// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
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

  it('keeps the dock open when the sidebar closes or the workspace board opens', async () => {
    const closeWorkspaceBoard = vi.fn()
    useAppStore.setState({
      agentDashboardDrawerOpen: true,
      settings: { ...getDefaultSettings('/workspaces'), experimentalAgentDashboardDocked: true }
    })
    render(
      <AgentDashboardSidebarHost
        sidebarOpen={false}
        workspaceBoardOpen
        closeWorkspaceBoard={closeWorkspaceBoard}
        statusBarVisible
      />
    )
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
    expect(closeWorkspaceBoard).not.toHaveBeenCalled()
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
