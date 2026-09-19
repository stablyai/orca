// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { AgentDashboardDock } from './AgentDashboardDock'
import type { AgentRevealArgs } from '../dashboard-popout/AgentTerminalDialog'

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(() => ({ generatedAt: 1, cards: [] })),
  reveal: vi.fn()
}))
vi.mock('./useLiveDashboardSnapshot', () => ({ useLiveDashboardSnapshot: mocks.snapshot }))
vi.mock('./reveal-dashboard-agent', () => ({ revealDashboardAgent: mocks.reveal }))
vi.mock('../dashboard-popout/AgentKanbanBoard', () => ({
  AgentKanbanBoard: ({
    onRevealAgent,
    onClose
  }: {
    onRevealAgent: (args: AgentRevealArgs) => void
    onClose: () => void
  }) => (
    <div>
      <button
        onClick={() =>
          onRevealAgent({
            repoId: 'repo',
            worktreeId: 'folder',
            tabId: 'tab',
            leafId: 'leaf',
            executionHostId: 'runtime:remote'
          })
        }
      >
        Open agent
      </button>
      <button onClick={onClose}>Close dashboard</button>
    </div>
  )
}))

const initialState = useAppStore.getInitialState()
beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/workspaces'),
      experimentalAgentDashboardPopout: true,
      experimentalAgentDashboardDocked: true,
      experimentalAgentDashboardMode: 'in-window'
    },
    agentDashboardDrawerOpen: true,
    activeView: 'terminal',
    sidebarOpen: false
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('AgentDashboardDock', () => {
  it('stays visible while using the workspace, pressing Escape, or revealing a remote agent', async () => {
    render(
      <>
        <AgentDashboardDock reserveTitlebarSpace />
        <button>Workspace</button>
      </>
    )
    const open = await screen.findByRole('button', { name: 'Open agent' })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.click(open)
    expect(mocks.reveal).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostId: 'runtime:remote' })
    )
    expect(screen.getByRole('region', { name: 'Docked Agent Dashboard' })).toBeTruthy()
    act(() => useAppStore.setState({ activeWorktreeId: 'another-folder', sidebarOpen: true }))
    expect(screen.getByRole('button', { name: 'Open agent' })).toBeTruthy()
    act(() => useAppStore.setState({ activeView: 'tasks' }))
    expect(screen.getByRole('region', { name: 'Docked Agent Dashboard' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close dashboard' }))
    expect(screen.queryByRole('region')).toBeNull()
  })

  it.each(['disabled', 'popout', 'undocked', 'closed', 'settings'] as const)(
    'does not subscribe to live snapshots when %s',
    (state) => {
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/workspaces'),
          ...useAppStore.getState().settings,
          experimentalAgentDashboardPopout: state !== 'disabled',
          experimentalAgentDashboardDocked: state !== 'undocked',
          experimentalAgentDashboardMode: state === 'popout' ? 'popout' : 'in-window'
        },
        agentDashboardDrawerOpen: state !== 'closed',
        activeView: state === 'settings' ? 'settings' : 'terminal'
      })
      render(<AgentDashboardDock reserveTitlebarSpace={false} />)
      expect(screen.queryByRole('region')).toBeNull()
      expect(mocks.snapshot).not.toHaveBeenCalled()
    }
  )

  it.each(['settings', 'activity', 'space'] as const)(
    'hides on %s and restores the open dock when returning to the workspace',
    async (activeView) => {
      render(<AgentDashboardDock reserveTitlebarSpace={false} />)
      await screen.findByRole('button', { name: 'Open agent' })
      mocks.snapshot.mockClear()

      act(() => useAppStore.setState({ activeView }))
      expect(screen.queryByRole('region', { name: 'Docked Agent Dashboard' })).toBeNull()
      expect(mocks.snapshot).not.toHaveBeenCalled()

      act(() => useAppStore.setState({ activeView: 'terminal' }))
      expect(await screen.findByRole('button', { name: 'Open agent' })).toBeTruthy()
    }
  )
})
