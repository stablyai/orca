import type { WorkspaceStatusDefinition } from './worktree/types'

export function buildWorkspaceStatusLookup(
  statuses: readonly WorkspaceStatusDefinition[]
): ReadonlyMap<string, WorkspaceStatusDefinition> {
  const first = new Map<string, WorkspaceStatusDefinition>()
  for (const status of statuses) {
    if (!first.has(status.id)) {
      first.set(status.id, status)
    }
  }
  return first
}
