import { folderWorkspaceToWorktree } from './folder-workspace-worktree'
import type { FolderWorkspace, WorkspaceKey, WorkspaceLineage, Worktree } from './types'
import { worktreeWorkspaceKey } from './workspace-scope'

export type WorktreeWithWorkspaceLineage<T extends Worktree = Worktree> = T & {
  workspaceLineage: WorkspaceLineage | null
}

type WorkspaceIdentity = {
  instanceId: string | null
  hostId: string | null
}

function getWorkspaceIdentities(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[]
): Map<WorkspaceKey, WorkspaceIdentity> {
  const identities = new Map<WorkspaceKey, WorkspaceIdentity>()
  for (const worktree of worktrees) {
    identities.set(worktreeWorkspaceKey(worktree.id), {
      instanceId: worktree.instanceId ?? null,
      hostId: worktree.hostId ?? null
    })
  }
  for (const folderWorkspace of folderWorkspaces) {
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    identities.set(worktree.id as WorkspaceKey, {
      instanceId: worktree.instanceId ?? null,
      hostId: worktree.hostId ?? null
    })
  }
  return identities
}

function isValidWorkspaceLineageEdge(
  lineage: WorkspaceLineage,
  child: WorkspaceIdentity | undefined,
  parent: WorkspaceIdentity | undefined
): boolean {
  return Boolean(
    child?.instanceId &&
    child.hostId &&
    parent?.instanceId &&
    parent.hostId &&
    lineage.childInstanceId === child.instanceId &&
    lineage.childHostId === child.hostId &&
    lineage.parentInstanceId === parent.instanceId &&
    lineage.parentHostId === parent.hostId &&
    child.hostId === parent.hostId
  )
}

function findCyclicChildKeys(
  lineageByChildKey: ReadonlyMap<WorkspaceKey, WorkspaceLineage>
): Set<WorkspaceKey> {
  const cyclic = new Set<WorkspaceKey>()
  const processed = new Set<WorkspaceKey>()
  for (const childKey of lineageByChildKey.keys()) {
    if (processed.has(childKey)) {
      continue
    }
    const path: WorkspaceKey[] = []
    const indexByKey = new Map<WorkspaceKey, number>()
    let cursor: WorkspaceKey | undefined = childKey
    while (cursor && lineageByChildKey.has(cursor) && !processed.has(cursor)) {
      const cycleStart = indexByKey.get(cursor)
      if (cycleStart !== undefined) {
        for (let index = cycleStart; index < path.length; index += 1) {
          cyclic.add(path[index])
        }
        break
      }
      indexByKey.set(cursor, path.length)
      path.push(cursor)
      cursor = lineageByChildKey.get(cursor)?.parentWorkspaceKey
    }
    for (const key of path) {
      processed.add(key)
    }
  }
  return cyclic
}

export function projectResolvedWorkspaceLineage<T extends Worktree>(
  worktrees: readonly T[],
  folderWorkspaces: readonly FolderWorkspace[],
  lineageByChildKey: Readonly<Record<WorkspaceKey, WorkspaceLineage>>
): WorktreeWithWorkspaceLineage<T>[] {
  const identities = getWorkspaceIdentities(worktrees, folderWorkspaces)
  const valid = new Map<WorkspaceKey, WorkspaceLineage>()
  for (const worktree of worktrees) {
    const childKey = worktreeWorkspaceKey(worktree.id)
    const lineage = lineageByChildKey[childKey]
    if (
      lineage?.childWorkspaceKey === childKey &&
      lineage.parentWorkspaceKey !== childKey &&
      isValidWorkspaceLineageEdge(
        lineage,
        identities.get(childKey),
        identities.get(lineage.parentWorkspaceKey)
      )
    ) {
      valid.set(childKey, lineage)
    }
  }
  for (const childKey of findCyclicChildKeys(valid)) {
    valid.delete(childKey)
  }
  return worktrees.map((worktree) => ({
    ...worktree,
    workspaceLineage: valid.get(worktreeWorkspaceKey(worktree.id)) ?? null
  }))
}
