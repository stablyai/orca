import { normalizeClaudeAccountBinding, type ClaudeAccountBinding } from './claude-account-binding'
import type { FolderWorkspace } from '../../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { Repo } from '../../repository/repo-types'
import { parseWorkspaceKey } from '../../workspace/identity/workspace-scope'
import { splitWorktreeId } from '../../worktree/id'

export type ClaudeWorkspaceBindingLookup = {
  getRepo: (repoId: string) => Pick<Repo, 'claudeAccount' | 'projectGroupId'> | undefined
  getFolderWorkspace: (id: string) => Pick<FolderWorkspace, 'projectGroupId'> | undefined
  getProjectGroups: () => readonly Pick<ProjectGroup, 'id' | 'parentGroupId' | 'claudeAccount'>[]
}

function groupBinding(
  groupId: string | null | undefined,
  lookup: ClaudeWorkspaceBindingLookup
): ClaudeAccountBinding | null {
  const groups = new Map(lookup.getProjectGroups().map((group) => [group.id, group]))
  const seen = new Set<string>()
  // Why the seen set: a corrupt parent chain must not loop forever.
  for (let id = groupId ?? null; id && !seen.has(id); id = groups.get(id)?.parentGroupId ?? null) {
    seen.add(id)
    const binding = normalizeClaudeAccountBinding(groups.get(id)?.claudeAccount)
    if (binding) {
      return binding
    }
  }
  return null
}

/** The project's own binding, else the nearest group's; null follows the account selection. */
export function claudeAccountBindingForWorkspace(
  workspaceId: string | undefined,
  lookup: ClaudeWorkspaceBindingLookup | undefined
): ClaudeAccountBinding | null {
  if (!workspaceId || !lookup) {
    return null
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return groupBinding(lookup.getFolderWorkspace(scope.folderWorkspaceId)?.projectGroupId, lookup)
  }
  const repoId = splitWorktreeId(
    scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  )?.repoId
  const repo = repoId ? lookup.getRepo(repoId) : undefined
  if (!repo) {
    return null
  }
  return (
    normalizeClaudeAccountBinding(repo.claudeAccount) ?? groupBinding(repo.projectGroupId, lookup)
  )
}
