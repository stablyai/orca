import { describe, expect, it, vi } from 'vitest'
import { applySidebarActivityToggle, isSidebarActivityViewVisible } from './sidebar-activity-toggle'

function toggleState(
  overrides: Partial<{ sidebarOpen: boolean; sidebarBody: 'workspaces' | 'agents' }> = {}
) {
  return {
    sidebarOpen: true,
    sidebarBody: 'workspaces' as const,
    setSidebarOpen: vi.fn(),
    setSidebarBody: vi.fn(),
    ...overrides
  }
}

describe('sidebar activity toggle', () => {
  it('treats activity as visible only when the sidebar is open on the agents body', () => {
    expect(isSidebarActivityViewVisible(true, 'agents')).toBe(true)
    expect(isSidebarActivityViewVisible(false, 'agents')).toBe(false)
    expect(isSidebarActivityViewVisible(true, 'workspaces')).toBe(false)
  })

  it('shows activity from the workspaces body and opens the sidebar', () => {
    const state = toggleState({ sidebarOpen: false, sidebarBody: 'workspaces' })
    applySidebarActivityToggle(state)
    expect(state.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(state.setSidebarBody).toHaveBeenCalledWith('agents')
  })

  it('shows activity when the sidebar is closed on a leftover agents body', () => {
    const state = toggleState({ sidebarOpen: false, sidebarBody: 'agents' })
    applySidebarActivityToggle(state)
    expect(state.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(state.setSidebarBody).toHaveBeenCalledWith('agents')
  })

  it('returns to workspaces when activity is already visible', () => {
    const state = toggleState({ sidebarOpen: true, sidebarBody: 'agents' })
    applySidebarActivityToggle(state)
    expect(state.setSidebarBody).toHaveBeenCalledWith('workspaces')
    expect(state.setSidebarOpen).not.toHaveBeenCalled()
  })
})
