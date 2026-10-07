import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../../../shared/folder-workspace-execution-host'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

export type FolderParentContext = {
  worktreeId: string
  instanceId: string
  identityKey: string
  executionHostId: string
  runtimeEnvironmentId: string | null
  target: RuntimeClientTarget
  selector: string
  mutationKey: string
  environmentRevision?: number
}

export type FolderParentCatalog = {
  target: RuntimeClientTarget
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}

export type FolderParentCandidate = {
  folder: FolderWorkspace
  groupName: string
  searchText: string
  isCurrent: boolean
}

export function captureFolderParentContext(
  state: WorktreeOperationRouteState,
  worktree: Worktree
): FolderParentContext | null {
  const identity = worktree.identity
  if (
    !identity?.key ||
    !worktree.instanceId ||
    identity.instanceId !== worktree.instanceId ||
    !parseExecutionHostId(identity.executionHostId) ||
    identity.key !==
      canonicalWorktreeIdentity({
        worktreeId: worktree.id,
        executionHostId: identity.executionHostId,
        instanceId: identity.instanceId
      })
  ) {
    return null
  }
  const owner = resolveExactWorktreeRoute(state, worktree)
  if (owner.kind !== 'resolved' || !owner.route.executionHostId) {
    return null
  }
  const runtimeEnvironmentId = owner.route.runtimeEnvironmentId
  const target: RuntimeClientTarget = runtimeEnvironmentId
    ? { kind: 'environment', environmentId: runtimeEnvironmentId }
    : { kind: 'local' }
  return {
    worktreeId: worktree.id,
    instanceId: identity.instanceId,
    identityKey: identity.key,
    executionHostId: identity.executionHostId,
    runtimeEnvironmentId,
    target,
    selector: `identity:${identity.key}`,
    mutationKey: JSON.stringify([runtimeEnvironmentId, identity.key]),
    environmentRevision: runtimeEnvironmentId
      ? getRuntimeEnvironmentRevision(runtimeEnvironmentId)
      : undefined
  }
}

/** The catalog must come from the captured target, not the UI's focused environment. */
export function getEligibleFolderWorkspaceParents(
  context: FolderParentContext,
  catalog: FolderParentCatalog,
  lineage: Readonly<Record<string, WorkspaceLineage>> = {}
): FolderParentCandidate[] {
  const childHost = parseExecutionHostId(context.executionHostId)
  if (
    !childHost ||
    catalog.target.kind !== context.target.kind ||
    (catalog.target.kind === 'environment' &&
      (context.target.kind !== 'environment' ||
        catalog.target.environmentId !== context.target.environmentId))
  ) {
    return []
  }
  const result: FolderParentCandidate[] = []
  for (const folder of catalog.folderWorkspaces) {
    if (folder.isArchived) {
      continue
    }
    const groups = catalog.projectGroups.filter((group) => group.id === folder.projectGroupId)
    if (groups.length !== 1) {
      continue
    }
    const folderStamp = parseExecutionHostId(folder.executionHostId)
    if (
      folderStamp &&
      (folderStamp.kind === 'runtime' ? folderStamp.environmentId : null) !==
        context.runtimeEnvironmentId
    ) {
      continue
    }
    // Fetched host stamps identify the catalog transport, not persisted execution authority.
    const host = resolveFolderWorkspaceHost(
      { ...catalog, folderWorkspaces: [{ ...folder, executionHostId: undefined }] },
      folder.id
    )
    if (
      host.kind === 'missing' ||
      host.kind === 'ambiguous' ||
      (host.kind === 'ssh'
        ? childHost.kind !== 'ssh' || host.targetId !== childHost.targetId
        : childHost.kind === 'ssh')
    ) {
      continue
    }
    if (
      catalog.folderWorkspaces.filter(
        (row) => row.id === folder.id && row.executionHostId === folder.executionHostId
      ).length !== 1
    ) {
      continue
    }
    const edge = lineage[worktreeWorkspaceKey(context.worktreeId)]
    result.push({
      folder,
      groupName: groups[0].name,
      searchText: `${folder.name} ${groups[0].name} ${folder.folderPath}`,
      isCurrent:
        edge?.parentWorkspaceKey === folderWorkspaceKey(folder.id) &&
        edge.childInstanceId === context.instanceId
    })
  }
  return result
}
