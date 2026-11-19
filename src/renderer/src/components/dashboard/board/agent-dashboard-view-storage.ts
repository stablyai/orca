import type { AgentDashboardView } from './AgentDashboardViewToggle'

const STORAGE_KEY = 'orca.agentDashboard.view'

export function loadAgentDashboardView(): AgentDashboardView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'fleet' ? 'fleet' : 'board'
  } catch {
    return 'board'
  }
}

export function saveAgentDashboardView(view: AgentDashboardView): void {
  try {
    if (view === 'fleet') {
      localStorage.setItem(STORAGE_KEY, 'fleet')
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // The chosen view still applies for this session when storage is unavailable or full.
  }
}
