import { afterEach, describe, expect, it, vi } from 'vitest'
import type { toggleAgentDashboardFromShortcut } from '../../../hooks/ipc-events/agent-dashboard-command'
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

  it('resolves a web client to in-window despite a pop-out setting', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const state = dashboardState()
    expect(resolveAgentDashboardMode(state.settings)).toBe('in-window')
  })
})
