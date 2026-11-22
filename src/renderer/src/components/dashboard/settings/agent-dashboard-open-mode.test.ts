import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isAgentDashboardInRightSidebar,
  resolveAgentDashboardMode,
  toggleAgentDashboardInRightSidebar
} from './agent-dashboard-open-mode'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveAgentDashboardMode', () => {
  it('falls back to in-window only for a pop-out a web client cannot open', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    expect(resolveAgentDashboardMode({ experimentalAgentDashboardMode: 'popout' })).toBe(
      'in-window'
    )
    expect(resolveAgentDashboardMode({ experimentalAgentDashboardMode: 'right-sidebar' })).toBe(
      'right-sidebar'
    )
  })
})

describe('isAgentDashboardInRightSidebar', () => {
  it('requires the experiment to be on', () => {
    expect(
      isAgentDashboardInRightSidebar({
        experimentalAgentDashboardPopout: false,
        experimentalAgentDashboardMode: 'right-sidebar'
      })
    ).toBe(false)
    expect(
      isAgentDashboardInRightSidebar({
        experimentalAgentDashboardPopout: true,
        experimentalAgentDashboardMode: 'right-sidebar'
      })
    ).toBe(true)
  })
})

describe('toggleAgentDashboardInRightSidebar', () => {
  function makeState(open: boolean, tab: 'explorer' | 'agent-dashboard' | null) {
    return {
      rightSidebarOpen: open,
      rightSidebarEffectiveTab: tab,
      setRightSidebarOpen: vi.fn(),
      setRightSidebarTab: vi.fn()
    }
  }

  it('closes the sidebar when the board is showing', () => {
    const state = makeState(true, 'agent-dashboard')
    toggleAgentDashboardInRightSidebar(state)
    expect(state.setRightSidebarOpen).toHaveBeenCalledWith(false)
    expect(state.setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('switches an open sidebar to the board instead of closing it', () => {
    const state = makeState(true, 'explorer')
    toggleAgentDashboardInRightSidebar(state)
    expect(state.setRightSidebarTab).toHaveBeenCalledWith('agent-dashboard')
    expect(state.setRightSidebarOpen).toHaveBeenCalledWith(true)
  })
})
