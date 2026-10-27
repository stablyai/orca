import type { GitStagingArea } from './git-status-types'

export type WorkspaceSpaceChange = { path: string; area: GitStagingArea }

export function isWorkspaceSpaceChange(value: unknown): value is WorkspaceSpaceChange {
  return (
    value !== null &&
    typeof value === 'object' &&
    'path' in value &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    value.path.length <= 32_768 &&
    'area' in value &&
    (value.area === 'staged' || value.area === 'unstaged' || value.area === 'untracked')
  )
}
