import { win32 } from 'node:path'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import { getRepoIdFromWorktreeId } from './worktree/id'
import { parseWorkspaceKey } from './workspace-scope'

export type ResolvedClaudeHomeBinding = {
  configDir: string
  /** The group that supplied it — may be an ancestor of the workspace's own group. */
  groupId: string
}

/**
 * A persisted binding, kept only when absolute. Why `win32.isAbsolute` for every platform:
 * groups sync between clients and remote hosts, so a macOS client must keep a Windows host's
 * `C:\…` or `\\server\share` binding intact — and `win32.isAbsolute` already accepts POSIX roots.
 */
export function normalizeClaudeConfigDir(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed && win32.isAbsolute(trimmed) ? trimmed : null
}

/** Nearest binding walking up `parentGroupId`. Bounded so a cycle that survived normalization ends. */
export function resolveClaudeHomeBindingForGroup(
  groups: readonly ProjectGroup[],
  groupId: string | null | undefined
): ResolvedClaudeHomeBinding | null {
  if (!groupId) {
    return null
  }
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const visited = new Set<string>()
  let currentId: string | null | undefined = groupId
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const group: ProjectGroup | undefined = groupsById.get(currentId)
    if (!group) {
      return null
    }
    const configDir = normalizeClaudeConfigDir(group.claudeConfigDir)
    if (configDir) {
      return { configDir, groupId: group.id }
    }
    currentId = group.parentGroupId
  }
  return null
}

export function resolveProjectGroupIdForWorkspace(input: {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceId: string
}): string | null {
  const scope = parseWorkspaceKey(input.workspaceId)
  const folderWorkspaceId = scope?.type === 'folder' ? scope.folderWorkspaceId : input.workspaceId
  const folderWorkspace = input.folderWorkspaces.find(
    (workspace) => workspace.id === folderWorkspaceId
  )
  if (folderWorkspace) {
    return folderWorkspace.projectGroupId || null
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : input.workspaceId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return input.repos.find((repo) => repo.id === repoId)?.projectGroupId ?? null
}

export function resolveClaudeHomeBindingForWorkspace(input: {
  groups: readonly ProjectGroup[]
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceId: string
}): ResolvedClaudeHomeBinding | null {
  return resolveClaudeHomeBindingForGroup(input.groups, resolveProjectGroupIdForWorkspace(input))
}
