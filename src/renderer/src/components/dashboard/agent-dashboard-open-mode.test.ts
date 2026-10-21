import { afterEach, describe, expect, it, vi } from 'vitest'
import { toggleAgentDashboardFromShortcut } from '../../hooks/ipc-events/agent-dashboard-command'
import { resolveAgentDashboardMode } from './agent-dashboard-open-mode'

function dashboardState(): Parameters<typeof toggleAgentDashboardFromShortcut>[0] {
  return {
    activeView: 'terminal',
    settings: {
      experimentalAgentDashboardPopout: true,
      experimentalAgentDashboardMode: 'popout'
    },
    agentDashboardDrawerOpen: false,
    setSidebarOpen: vi.fn(),
    setAgentDashboardDrawerOpen: vi.fn()
  }
}

describe('Agent Dashboard open mode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens the pop-out window on desktop when the setting asks for it', () => {
    const state = dashboardState()
    const openPopout = vi.fn()
    toggleAgentDashboardFromShortcut(state, openPopout)
    expect(openPopout).toHaveBeenCalledTimes(1)
    expect(state.setAgentDashboardDrawerOpen).not.toHaveBeenCalled()
  })

  // #22218: a browser tab has no second window, so pop-out was a silent no-op.
  it('opens the in-window board in a web client even when the setting says pop-out', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const state = dashboardState()
    const openPopout = vi.fn()
    expect(resolveAgentDashboardMode(state.settings)).toBe('in-window')
    toggleAgentDashboardFromShortcut(state, openPopout)
    expect(openPopout).not.toHaveBeenCalled()
    expect(state.setAgentDashboardDrawerOpen).toHaveBeenCalledWith(true)
  })
})
