export const SIDEBAR_BODIES = ['conversations', 'workspaces', 'agents'] as const

export type SidebarBody = (typeof SIDEBAR_BODIES)[number]

export const DEFAULT_SIDEBAR_BODY: SidebarBody = 'workspaces'

export function normalizeSidebarBody(value: unknown): SidebarBody {
  return SIDEBAR_BODIES.find((body) => body === value) ?? DEFAULT_SIDEBAR_BODY
}
