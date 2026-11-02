/** Folder host resolution for many folders over one catalog: the same decisions as
 *  `resolveQualifiedFolderWorkspaceResult`, with rows indexed once, pins settled before any repo is
 *  read, and each group subtree's and each path's repos summarized once for every folder asking. */

import type { ExecutionHostId } from './execution-host'
import type {
  FolderHostCatalog,
  FolderHostRepo,
  FolderHostWorkspace,
  QualifiedFolderWorkspaceResult
} from './folder-workspace-execution-host'
import {
  classifyFolderScope,
  folderScopeRepo,
  mergeFolderScopeRepos,
  NO_FOLDER_SCOPE_REPOS,
  pinnedFolderRowHost,
  qualifyFolderWorkspaceRows,
  type FolderScopeRepos
} from './folder-workspace-host-decision'
import { isPathInsideOrEqual } from './cross-platform-path'
import { buildProjectGroupChildIndex, collectProjectGroupSubtreeIds } from './project-groups'

type Group = FolderHostCatalog['projectGroups'][number]

function bucket<V>(map: Map<string, V[]>, key: string, value: V): void {
  const rows = map.get(key)
  if (rows) {
    rows.push(value)
  } else {
    map.set(key, [value])
  }
}

export function createFolderWorkspaceHostIndex<W extends FolderHostWorkspace>(state: {
  folderWorkspaces: readonly W[]
  projectGroups: readonly Group[]
  repos: readonly FolderHostRepo[]
}): (
  folderWorkspaceId: string,
  requiredHostId?: ExecutionHostId
) => QualifiedFolderWorkspaceResult<W> {
  const foldersById = new Map<string, W[]>()
  for (const folder of state.folderWorkspaces) {
    bucket(foldersById, folder.id, folder)
  }
  const groupsById = new Map<string, Group[]>()
  for (const group of state.projectGroups) {
    bucket(groupsById, group.id, group)
  }
  const children = buildProjectGroupChildIndex(state.projectGroups)
  const ownRepos = new Map<string, FolderScopeRepos>()
  for (const repo of state.repos) {
    const groupId = repo.projectGroupId
    if (typeof groupId === 'string') {
      ownRepos.set(
        groupId,
        mergeFolderScopeRepos(ownRepos.get(groupId) ?? NO_FOLDER_SCOPE_REPOS, folderScopeRepo(repo))
      )
    }
  }
  const subtreeRepos = new Map<string, FolderScopeRepos>()
  const pathRepos = new Map<string, FolderScopeRepos>()

  // Post-order over the child index, each group summarized once. A parent cycle (malformed data)
  // has no post-order; that one subtree is collected and summarized whole instead.
  const subtree = (rootId: string): FolderScopeRepos => {
    const known = subtreeRepos.get(rootId)
    if (known) {
      return known
    }
    const open = new Set([rootId])
    const stack: { id: string; next: number; repos: FolderScopeRepos }[] = [
      { id: rootId, next: 0, repos: ownRepos.get(rootId) ?? NO_FOLDER_SCOPE_REPOS }
    ]
    while (stack.length > 0) {
      const frame = stack.at(-1)!
      const childIds = children.get(frame.id) ?? []
      if (frame.next < childIds.length) {
        const childId = childIds[frame.next++]
        const child = subtreeRepos.get(childId)
        if (child) {
          frame.repos = mergeFolderScopeRepos(frame.repos, child)
        } else if (open.has(childId)) {
          let repos = NO_FOLDER_SCOPE_REPOS
          for (const id of collectProjectGroupSubtreeIds(children, rootId)) {
            repos = mergeFolderScopeRepos(repos, ownRepos.get(id) ?? NO_FOLDER_SCOPE_REPOS)
          }
          return repos
        } else {
          open.add(childId)
          stack.push({
            id: childId,
            next: 0,
            repos: ownRepos.get(childId) ?? NO_FOLDER_SCOPE_REPOS
          })
        }
        continue
      }
      stack.pop()
      open.delete(frame.id)
      subtreeRepos.set(frame.id, frame.repos)
      const parent = stack.at(-1)
      if (parent) {
        parent.repos = mergeFolderScopeRepos(parent.repos, frame.repos)
      }
    }
    return subtreeRepos.get(rootId)!
  }

  const insidePath = (folderPath: string): FolderScopeRepos => {
    let repos = pathRepos.get(folderPath)
    if (!repos) {
      repos = NO_FOLDER_SCOPE_REPOS
      for (const repo of state.repos) {
        if (repo.path && isPathInsideOrEqual(folderPath, repo.path)) {
          repos = mergeFolderScopeRepos(repos, folderScopeRepo(repo))
        }
      }
      pathRepos.set(folderPath, repos)
    }
    return repos
  }

  return (folderWorkspaceId, requiredHostId) =>
    qualifyFolderWorkspaceRows(
      foldersById.get(folderWorkspaceId) ?? [],
      (workspace) => groupsById.get(workspace.projectGroupId),
      (workspace) => {
        const pinned = pinnedFolderRowHost(
          workspace,
          groupsById.get(workspace.projectGroupId) ?? []
        )
        if ('host' in pinned) {
          return pinned.host
        }
        // Path repos only count when they share the scope's connection, so they can change the
        // answer only for a scope with no connection and no group repos.
        const group = subtree(workspace.projectGroupId)
        return classifyFolderScope(
          pinned.scopeConnectionId,
          pinned.scopeConnectionId || group.hasLocalRepo || group.connectionId
            ? group
            : workspace.folderPath
              ? insidePath(workspace.folderPath)
              : NO_FOLDER_SCOPE_REPOS
        )
      },
      true,
      requiredHostId
    )
}
