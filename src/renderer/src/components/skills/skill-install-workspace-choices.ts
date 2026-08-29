import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

export type SkillInstallWorkspaceChoice = {
  id: string
  label: string
  kind: 'worktree' | 'folder'
}

function belongsToEnvironment(
  value: Worktree | FolderWorkspace,
  machineId: string,
  repo?: Repo
): boolean {
  const folder = 'folderPath' in value
  const hostId = folder
    ? value.executionHostId
    : (value.hostId ??
      repo?.executionHostId ??
      (repo?.connectionId ? (`ssh:${repo.connectionId}` as const) : undefined))
  const runtimeOwner = folder ? null : value.runtimeOwnerEnvironmentId
  if (machineId.startsWith('ssh:')) {
    return hostId === machineId
  }
  if (machineId !== 'local') {
    return runtimeOwner === machineId || hostId === `runtime:${machineId}`
  }
  return !runtimeOwner && (!hostId || hostId === 'local')
}

export function skillInstallWorkspaceChoices(input: {
  environmentId: string
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
  folderWorkspaces: readonly FolderWorkspace[]
  repos: readonly Repo[]
}): SkillInstallWorkspaceChoice[] {
  const repos = new Map(input.repos.map((repo) => [repo.id, repo]))
  const worktrees = Object.values(input.worktreesByRepo)
    .flat()
    .filter((value) => belongsToEnvironment(value, input.environmentId, repos.get(value.repoId)))
    .map((value) => ({ id: value.id, label: value.displayName, kind: 'worktree' as const }))
  const folders = input.folderWorkspaces
    .filter((value) => belongsToEnvironment(value, input.environmentId))
    .map((value) => ({ id: value.id, label: value.name, kind: 'folder' as const }))
  return [...worktrees, ...folders].sort((left, right) => left.label.localeCompare(right.label))
}
