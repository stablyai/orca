import { describe, expect, it, vi } from 'vitest'
import { toggleAgentDashboardFromShortcut } from './ipc-events/agent-dashboard-command'

function makeState(
  overrides: {
    activeView?: string
    experimentEnabled?: boolean
    mode?: 'in-window' | 'popout'
    drawerOpen?: boolean
  } = {}
) {
  return {
    activeView: overrides.activeView ?? 'terminal',
    settings: {
      experimentalAgentDashboardPopout: overrides.experimentEnabled ?? true,
      experimentalAgentDashboardMode: overrides.mode ?? 'in-window'
    },
    agentDashboardDrawerOpen: overrides.drawerOpen ?? false,
    setSidebarOpen: vi.fn(),
    setAgentDashboardDrawerOpen: vi.fn()
  }
}

describe('toggleAgentDashboardFromShortcut', () => {
  it('stays inert while the Agent Dashboard experiment is off', () => {
    const state = makeState({ experimentEnabled: false })
    const openPopout = vi.fn()

    toggleAgentDashboardFromShortcut(state as never, openPopout)

    expect(openPopout).not.toHaveBeenCalled()
    expect(state.setAgentDashboardDrawerOpen).not.toHaveBeenCalled()
    expect(state.setSidebarOpen).not.toHaveBeenCalled()
  })

  it('stays inert in the Settings view', () => {
    const state = makeState({ activeView: 'settings' })
    const openPopout = vi.fn()

    toggleAgentDashboardFromShortcut(state as never, openPopout)

    expect(openPopout).not.toHaveBeenCalled()
    expect(state.setAgentDashboardDrawerOpen).not.toHaveBeenCalled()
  })

  it('opens the pop-out window in popout mode without touching the drawer', () => {
    const state = makeState({ mode: 'popout' })
    const openPopout = vi.fn()

    toggleAgentDashboardFromShortcut(state as never, openPopout)

    expect(openPopout).toHaveBeenCalledOnce()
    expect(state.setAgentDashboardDrawerOpen).not.toHaveBeenCalled()
    expect(state.setSidebarOpen).not.toHaveBeenCalled()
  })

  it('reveals the sidebar when opening the in-window drawer', () => {
    const state = makeState({ drawerOpen: false })

    toggleAgentDashboardFromShortcut(state as never, vi.fn())

    expect(state.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(state.setAgentDashboardDrawerOpen).toHaveBeenCalledWith(true)
  })

  it('leaves the sidebar alone when closing the in-window drawer', () => {
    // Why: forcing the sidebar open on close would re-reveal a panel the user
    // just dismissed, and the drawer's own collapse effect would fight it.
    const state = makeState({ drawerOpen: true })

    toggleAgentDashboardFromShortcut(state as never, vi.fn())

    expect(state.setAgentDashboardDrawerOpen).toHaveBeenCalledWith(false)
    expect(state.setSidebarOpen).not.toHaveBeenCalled()
  })
})
