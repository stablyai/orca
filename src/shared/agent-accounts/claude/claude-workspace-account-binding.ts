import { normalizeClaudeAccountBinding, type ClaudeAccountBinding } from './claude-account-binding'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../execution-host/execution-host'
import type { FolderWorkspace } from '../../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { Repo } from '../../repository/repo-types'
import { parseWorkspaceKey } from '../../workspace/identity/workspace-scope'
import { splitWorktreeId } from '../../worktree/id'

type HostFields = 'connectionId' | 'executionHostId'

export type ClaudeWorkspaceBindingLookup = {
  getRepo: (
    repoId: string
  ) => Pick<Repo, 'claudeAccount' | 'projectGroupId' | HostFields> | undefined
  getFolderWorkspace: (
    id: string
  ) => Pick<FolderWorkspace, 'projectGroupId' | HostFields> | undefined
  getProjectGroups: () => readonly Pick<
    ProjectGroup,
    'id' | 'parentGroupId' | 'claudeAccount' | HostFields
  >[]
}

function groupBinding(
  groupId: string | null | undefined,
  hostId: ExecutionHostId,
  lookup: ClaudeWorkspaceBindingLookup
): ClaudeAccountBinding | null {
  // Why by host: group ids repeat across hosts, and another host's group must not bind this one.
  const groups = new Map(
    lookup
      .getProjectGroups()
      .filter((group) => getRepoExecutionHostId(group) === hostId)
      .map((group) => [group.id, group])
  )
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
    const folder = lookup.getFolderWorkspace(scope.folderWorkspaceId)
    return folder
      ? groupBinding(folder.projectGroupId, getRepoExecutionHostId(folder), lookup)
      : null
  }
  const repoId = splitWorktreeId(
    scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  )?.repoId
  const repo = repoId ? lookup.getRepo(repoId) : undefined
  if (!repo) {
    return null
  }
  return (
    normalizeClaudeAccountBinding(repo.claudeAccount) ??
    groupBinding(repo.projectGroupId, getRepoExecutionHostId(repo), lookup)
  )
}
