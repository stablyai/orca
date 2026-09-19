export type SidebarActivityToggleState = {
  sidebarOpen: boolean
  sidebarBody?: 'workspaces' | 'agents'
  setSidebarOpen: (open: boolean) => void
  setSidebarBody: (body: 'workspaces' | 'agents') => void
}

export function isSidebarActivityViewVisible(
  sidebarOpen: boolean,
  sidebarBody: SidebarActivityToggleState['sidebarBody']
): boolean {
  return sidebarOpen && sidebarBody === 'agents'
}

export function applySidebarActivityToggle(state: SidebarActivityToggleState): void {
  if (isSidebarActivityViewVisible(state.sidebarOpen, state.sidebarBody)) {
    state.setSidebarBody('workspaces')
    return
  }
  state.setSidebarOpen(true)
  state.setSidebarBody('agents')
}
