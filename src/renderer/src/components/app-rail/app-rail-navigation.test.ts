import { describe, expect, it, vi } from 'vitest'
import { activateWorkspacesRailItem, returnToTerminalView } from './app-rail-navigation'

type View = 'terminal' | 'settings' | 'tasks' | 'automations'

const emptyHistory: string[] = []

function fakeStore(initial: {
  activeView: View
  sidebarBody: 'workspaces' | 'agents'
  sidebarOpen: boolean
  closesTo?: View
}) {
  const state = {
    activeView: initial.activeView,
    sidebarBody: initial.sidebarBody,
    sidebarOpen: initial.sidebarOpen,
    setActiveView: vi.fn((view: View) => {
      state.activeView = view
    }),
    setSidebarBody: vi.fn((body: 'workspaces' | 'agents') => {
      state.sidebarBody = body
    }),
    setSidebarOpen: vi.fn((open: boolean) => {
      state.sidebarOpen = open
    }),
    toggleSidebar: vi.fn(() => {
      state.sidebarOpen = !state.sidebarOpen
    }),
    closeTaskPage: vi.fn(() => {
      state.activeView = initial.closesTo ?? 'terminal'
    }),
    closeAutomationsPage: vi.fn(),
    closeArtifactsPage: vi.fn(),
    closeSkillsPage: vi.fn(),
    closeSettingsPage: vi.fn(() => {
      state.activeView = initial.closesTo ?? 'terminal'
    }),
    closeActivityPage: vi.fn(),
    closeSpacePage: vi.fn(),
    closeMobilePage: vi.fn(),
    worktreeNavHistory: emptyHistory,
    worktreeNavHistoryIndex: -1
  }
  return {
    state,
    getState: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fake store; returnToTerminalView/activateWorkspacesRailItem only read and call the fields defined above.
      getState: () => state as never,
      setState: vi.fn()
    }
  }
}

describe('returnToTerminalView', () => {
  it("leaves a page through that page's own close action", () => {
    const { state, getState } = fakeStore({
      activeView: 'tasks',
      sidebarBody: 'workspaces',
      sidebarOpen: true
    })
    returnToTerminalView(getState)
    expect(state.closeTaskPage).toHaveBeenCalledTimes(1)
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.activeView).toBe('terminal')
  })

  it('still lands on the terminal when the page closes back to another page', () => {
    const { state, getState } = fakeStore({
      activeView: 'tasks',
      sidebarBody: 'workspaces',
      sidebarOpen: true,
      closesTo: 'automations'
    })
    returnToTerminalView(getState)
    expect(state.closeTaskPage).toHaveBeenCalledTimes(1)
    expect(state.activeView).toBe('terminal')
  })
})

describe('activateWorkspacesRailItem', () => {
  it('toggles the list when Workspaces is already showing on the terminal view', () => {
    const { state, getState } = fakeStore({
      activeView: 'terminal',
      sidebarBody: 'workspaces',
      sidebarOpen: true
    })
    activateWorkspacesRailItem(getState)
    expect(state.sidebarOpen).toBe(false)
    activateWorkspacesRailItem(getState)
    expect(state.sidebarOpen).toBe(true)
  })

  it('returns to the terminal and opens the list from another page without collapsing it', () => {
    const { state, getState } = fakeStore({
      activeView: 'settings',
      sidebarBody: 'workspaces',
      sidebarOpen: false
    })
    activateWorkspacesRailItem(getState)
    expect(state.closeSettingsPage).toHaveBeenCalledTimes(1)
    expect(state.activeView).toBe('terminal')
    expect(state.sidebarOpen).toBe(true)
    expect(state.toggleSidebar).not.toHaveBeenCalled()
  })

  it('switches the list body back to workspaces and keeps an open list open', () => {
    const { state, getState } = fakeStore({
      activeView: 'terminal',
      sidebarBody: 'agents',
      sidebarOpen: true
    })
    activateWorkspacesRailItem(getState)
    expect(state.sidebarBody).toBe('workspaces')
    expect(state.sidebarOpen).toBe(true)
    expect(state.toggleSidebar).not.toHaveBeenCalled()
  })
})
