import {
  resolveAgentsSidebarVisible,
  type AgentsSidebarVisibilitySettings
} from '../../../../shared/agents-sidebar-visibility'

export function shouldShowAgentsSidebar(
  settings: Partial<AgentsSidebarVisibilitySettings> | null | undefined
): boolean {
  // Settings hydrate after first render; avoid flashing UI for opted-out profiles.
  return settings ? resolveAgentsSidebarVisible(settings) : false
}
