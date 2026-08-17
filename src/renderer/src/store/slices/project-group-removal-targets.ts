import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  buildProjectGroupOwnerIndex,
  getProjectGroupIdentity,
  getProjectGroupOwnerHostId,
  getProjectGroupOwnerIdentity,
  getProjectGroupOwnerSubtreeIdentities,
  resolveProjectGroupOwner
} from '../../../../shared/project-groups'
import { resolveFolderWorkspaceProjectGroupWithLegacySsh } from '../../../../shared/folder-workspaces'
import { getRepoHostIdentity } from './repo-host-identity'

export type ProjectGroupRemovalTargets = {
  groupExists: boolean
  ownerHostId: ExecutionHostId | null
  deletedGroupIds: Set<string>
  deletedGroupIdentities: Set<string>
  projectIds: string[]
  projectTargets: { projectId: string; ownerHostId: ExecutionHostId; identity: string }[]
  folderWorkspaceIdentities: Set<string>
}

export function selectProjectGroupRemovalTargets(
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[],
  groupId: string,
  ownerHostId?: ExecutionHostId,
  folderWorkspaces: readonly FolderWorkspace[] = []
): ProjectGroupRemovalTargets {
  const index = buildProjectGroupOwnerIndex(projectGroups)
  const rootGroup = resolveProjectGroupOwner(index, groupId, ownerHostId)
  if (!rootGroup) {
    return {
      groupExists: false,
      ownerHostId: null,
      deletedGroupIds: new Set(),
      deletedGroupIdentities: new Set(),
      projectIds: [],
      projectTargets: [],
      folderWorkspaceIdentities: new Set()
    }
  }
  const selectedOwnerHostId = getProjectGroupOwnerHostId(rootGroup)
  const deletedGroupIdentities = getProjectGroupOwnerSubtreeIdentities(projectGroups, rootGroup)
  const deletedGroupIds = new Set(
    projectGroups.flatMap((group) =>
      deletedGroupIdentities.has(
        getProjectGroupIdentity(group.id, getProjectGroupOwnerHostId(group))
      )
        ? [group.id]
        : []
    )
  )
  const projectTargets: {
    projectId: string
    ownerHostId: ExecutionHostId
    identity: string
  }[] = []
  const seenProjectIdentities = new Set<string>()
  for (const repo of repos) {
    if (!repo.projectGroupId) {
      continue
    }
    const repoOwnerHostId = getRepoExecutionHostId(repo)
    const groupIdentity = getProjectGroupIdentity(repo.projectGroupId, repoOwnerHostId)
    const identity = getRepoHostIdentity(repo)
    if (deletedGroupIdentities.has(groupIdentity) && !seenProjectIdentities.has(identity)) {
      seenProjectIdentities.add(identity)
      projectTargets.push({ projectId: repo.id, ownerHostId: repoOwnerHostId, identity })
    }
  }
  const folderWorkspaceIdentities = new Set<string>()
  for (const workspace of folderWorkspaces) {
    const group = resolveFolderWorkspaceProjectGroupWithLegacySsh(index, workspace)
    if (group && deletedGroupIdentities.has(getProjectGroupOwnerIdentity(group))) {
      folderWorkspaceIdentities.add(
        JSON.stringify([getProjectGroupOwnerHostId(group), workspace.id])
      )
    }
  }

  return {
    groupExists: true,
    ownerHostId: selectedOwnerHostId,
    deletedGroupIds,
    deletedGroupIdentities,
    projectIds: projectTargets.map((target) => target.projectId),
    projectTargets,
    folderWorkspaceIdentities
  }
}
