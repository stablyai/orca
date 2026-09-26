/** Sidebar "Group by" modes. The single list every persisted, wire, and UI union derives from. */
export const WORKSPACE_GROUP_BY_VALUES = [
  'none',
  'workspace-status',
  'repo',
  'pr-status',
  'tag'
] as const

export type WorkspaceGroupBy = (typeof WORKSPACE_GROUP_BY_VALUES)[number]

export function isWorkspaceGroupBy(value: unknown): value is WorkspaceGroupBy {
  return WORKSPACE_GROUP_BY_VALUES.some((mode) => mode === value)
}
