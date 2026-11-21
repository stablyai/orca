/** Lists the sidebar can open on, chosen from its title menu or Settings → Appearance. */
export const SIDEBAR_VIEWS = ['workspaces', 'conversations'] as const

export type SidebarView = (typeof SIDEBAR_VIEWS)[number]

/** What the sidebar shows right now: the chosen view, a transient switch, or Activity over it. */
export type SidebarBody = SidebarView | 'agents'

export const DEFAULT_SIDEBAR_VIEW: SidebarView = 'workspaces'

export function normalizeSidebarView(value: unknown): SidebarView {
  return SIDEBAR_VIEWS.find((view) => view === value) ?? DEFAULT_SIDEBAR_VIEW
}
