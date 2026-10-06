// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { AgentDashboardExperimentalSetting } from './AgentDashboardExperimentalSetting'
import AgentDashboardSidebarHost from '../sidebar/AgentDashboardSidebarHost'

vi.mock('@/components/dashboard/AgentDashboardDrawer', () => ({
  AgentDashboardDrawer: () => {
    const open = useAppStore((s) => s.agentDashboardDrawerOpen)
    return open ? <section aria-label="Sidebar dashboard" /> : null
  }
}))

const initialState = useAppStore.getInitialState()
const closeWorkspaceBoard = vi.fn()

function SettingsWithSidebar(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings!)
  const activeView = useAppStore((s) => s.activeView)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  return activeView === 'settings' ? (
    <>
      <AgentDashboardExperimentalSetting
        settings={settings}
        updateSettings={(updates) =>
          useAppStore.setState({ settings: { ...useAppStore.getState().settings!, ...updates } })
        }
      />
      <button onClick={() => useAppStore.setState({ activeView: 'terminal' })}>
        Back to workspace
      </button>
    </>
  ) : (
    <AgentDashboardSidebarHost
      sidebarOpen={sidebarOpen}
      workspaceBoardOpen={false}
      closeWorkspaceBoard={closeWorkspaceBoard}
      statusBarVisible
    />
  )
}

beforeEach(() => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/workspaces'),
      experimentalAgentDashboardPopout: true,
      experimentalAgentDashboardDocked: true,
      experimentalAgentDashboardMode: 'in-window'
    },
    agentDashboardDrawerOpen: true,
    activeView: 'settings',
    sidebarOpen: false
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

describe('AgentDashboardExperimentalSetting', () => {
  it('restores the sidebar dashboard after undocking in settings with the sidebar closed', () => {
    render(<SettingsWithSidebar />)
    fireEvent.click(screen.getByRole('switch', { name: 'Dock above workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }))
    expect(screen.getByRole('region', { name: 'Sidebar dashboard' })).toBeTruthy()
  })
})
