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
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from './cross-platform-path'
import { buildProjectGroupChildIndex } from './project-groups'

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

  // Groups reachable from each other (a parent cycle in malformed data) share one summary: one
  // iterative strongly-connected-component pass closes each component after everything it reaches,
  // so every group and child edge is visited once per pass, whichever groups are asked about.
  const subtree = (rootId: string): FolderScopeRepos => {
    const known = subtreeRepos.get(rootId)
    if (known) {
      return known
    }
    const order = new Map<string, number>()
    const low = new Map<string, number>()
    const open: string[] = []
    const onStack = new Set<string>()
    const frames: { id: string; next: number }[] = []
    const enter = (id: string) => {
      order.set(id, order.size)
      low.set(id, order.size - 1)
      open.push(id)
      onStack.add(id)
      frames.push({ id, next: 0 })
    }
    enter(rootId)
    while (frames.length > 0) {
      const frame = frames.at(-1)!
      const childIds = children.get(frame.id) ?? []
      if (frame.next < childIds.length) {
        const childId = childIds[frame.next++]
        if (!subtreeRepos.has(childId)) {
          if (!order.has(childId)) {
            enter(childId)
          } else if (onStack.has(childId)) {
            low.set(frame.id, Math.min(low.get(frame.id)!, order.get(childId)!))
          }
        }
        continue
      }
      frames.pop()
      const parent = frames.at(-1)
      if (parent) {
        low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!))
      }
      if (low.get(frame.id) !== order.get(frame.id)) {
        continue
      }
      const members: string[] = []
      let member: string
      do {
        member = open.pop()!
        onStack.delete(member)
        members.push(member)
      } while (member !== frame.id)
      // Components it reaches closed first, so their summaries are already known.
      let repos = NO_FOLDER_SCOPE_REPOS
      for (const id of members) {
        repos = mergeFolderScopeRepos(repos, ownRepos.get(id) ?? NO_FOLDER_SCOPE_REPOS)
        for (const childId of children.get(id) ?? []) {
          const reached = subtreeRepos.get(childId)
          repos = reached ? mergeFolderScopeRepos(repos, reached) : repos
        }
      }
      for (const id of members) {
        subtreeRepos.set(id, repos)
      }
    }
    return subtreeRepos.get(rootId)!
  }

  // Keyed by the containment predicate's own comparison identity, so equivalent spellings of one
  // directory share a scan; matchers take the raw root, as that identity is not idempotent for WSL.
  let normalizedRepoPaths: (string | null)[] | undefined
  const insidePath = (folderPath: string): FolderScopeRepos => {
    const key = normalizeRuntimePathForComparison(folderPath)
    let repos = pathRepos.get(key)
    if (!repos) {
      normalizedRepoPaths ??= state.repos.map(({ path }) =>
        path ? normalizeRuntimePathForComparison(path) : null
      )
      const inside = createNormalizedPathInsideOrEqualMatcher(folderPath)
      repos = NO_FOLDER_SCOPE_REPOS
      for (const [index, repo] of state.repos.entries()) {
        const path = normalizedRepoPaths[index]
        if (path && inside(path)) {
          repos = mergeFolderScopeRepos(repos, folderScopeRepo(repo))
        }
      }
      pathRepos.set(key, repos)
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
