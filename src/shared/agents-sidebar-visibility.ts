export type AgentsSidebarVisibilitySettings = {
  showAgentsSidebar?: boolean
}

export function resolveAgentsSidebarVisible(
  settings: Partial<AgentsSidebarVisibilitySettings> | null | undefined
): boolean {
  if (!settings) {
    return true
  }
  return settings.showAgentsSidebar !== false
}
