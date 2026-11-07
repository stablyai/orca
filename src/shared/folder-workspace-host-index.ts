/** Batch folder host decisions with shared group and containment-prefix summaries. */

import type { ExecutionHostId } from './execution-host'
import type {
  FolderHostCatalog,
  FolderHostRepo,
  FolderHostWorkspace,
  QualifiedFolderWorkspaceResult
} from './folder-workspaces/folder-workspace-execution-host'
import {
  classifyFolderScope,
  folderScopeRepo,
  mergeFolderScopeRepos,
  NO_FOLDER_SCOPE_REPOS,
  pinnedFolderRowHost,
  qualifyFolderWorkspaceRows,
  type FolderScopeRepos
} from './folder-workspace-host-decision'
import { normalizeRuntimePathForComparison } from './cross-platform-path'
import { buildProjectGroupChildIndex } from './project-groups'

type Group = FolderHostCatalog['projectGroups'][number]
type RepoPathNode = { children: Map<number, RepoPathNode>; repos: FolderScopeRepos }

function indexRepoPaths(repos: readonly FolderHostRepo[]): (root: string) => FolderScopeRepos {
  const createNode = (): RepoPathNode => ({ children: new Map(), repos: NO_FOLDER_SCOPE_REPOS })
  const root = createNode()
  for (const repo of repos) {
    const rawPath = repo.path
    const path = rawPath ? normalizeRuntimePathForComparison(rawPath) : ''
    if (!path) {
      continue
    }
    const summary = folderScopeRepo(repo)
    let node = root
    // An empty normalized root uses '/' as its descendant boundary.
    if (path.charCodeAt(0) === 47) {
      node.repos = mergeFolderScopeRepos(node.repos, summary)
    }
    const drive = /^[a-z]:\//i.test(path)
    for (let i = 0; i < path.length; i++) {
      const code = path.charCodeAt(i)
      let child = node.children.get(code)
      if (!child) {
        child = createNode()
        node.children.set(code, child)
      }
      node = child
      // Exact paths and slash-boundary ancestors match; '/' and drive roots include every tail.
      if (
        i === path.length - 1 ||
        path.charCodeAt(i + 1) === 47 ||
        (i === 0 && code === 47) ||
        (i === 2 && drive)
      ) {
        node.repos = mergeFolderScopeRepos(node.repos, summary)
      }
    }
  }
  return (path) => {
    let node = root
    for (let i = 0; i < path.length; i++) {
      const child = node.children.get(path.charCodeAt(i))
      if (!child) {
        return NO_FOLDER_SCOPE_REPOS
      }
      node = child
    }
    return node.repos
  }
}

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

  // One current-catalog index, built only when pins/groups cannot settle a host. Normalize raw
  // paths once: re-normalizing a WSL key would fold its case-sensitive Linux tail.
  let pathRepos: ReturnType<typeof indexRepoPaths> | undefined
  const insidePath = (folderPath: string): FolderScopeRepos =>
    (pathRepos ??= indexRepoPaths(state.repos))(normalizeRuntimePathForComparison(folderPath))

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
