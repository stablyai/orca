import type { WorkspaceSidebarPosition } from './ui-chrome-types'

export const DEFAULT_WORKSPACE_SIDEBAR_POSITION: WorkspaceSidebarPosition = 'left'

/** A stored value from an older or hand-edited profile falls back to the default edge instead of reading as `right`. */
export function normalizeWorkspaceSidebarPosition(value: unknown): WorkspaceSidebarPosition {
  return value === 'right' ? 'right' : DEFAULT_WORKSPACE_SIDEBAR_POSITION
}
