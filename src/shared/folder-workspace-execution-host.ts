/**
 * Resolves which host a folder workspace executes on.
 *
 * Main and the renderer both have to answer this — the list projects a record's
 * host from it, dispatch targets one from it — so the answer lives here rather
 * than being re-derived per side and drifting. The workspace's own
 * `executionHostId` pin wins: a pinned workspace runs there whatever its repos
 * say, which is exactly the case that used to read as local.
 *
 * `ambiguous` is a distinct answer, not a missing one: a scope that spans a
 * local repo and an SSH one has no single host, and callers must fail closed
 * with something visible rather than defaulting to local.
 */

import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import { isPathInsideOrEqual } from './cross-platform-path'
import { getProjectGroupSubtreeIds } from './project-groups'
import { parseExecutionHostId } from './execution-host'

export type FolderWorkspaceHostState = {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}

export type FolderWorkspaceHost =
  | { kind: 'missing' }
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'ambiguous' }

/** Reads a stored connection id: blank is local, since no write path normalizes it. */
export function normalizeConnectionId(value: string | null | undefined): string | null {
  return value?.trim() || null
}

function getFolderScopeCandidateRepos(args: {
  folderPath: string
  projectGroupId: string
  connectionId: string | null
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): Repo[] {
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  const groupRepos = args.repos.filter(
    (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
  )
  const pathRepos = args.repos.filter(
    (repo) =>
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(args.folderPath, repo.path)
  )
  if (args.connectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => normalizeConnectionId(repo.connectionId) === args.connectionId)
    ]
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  const groupConnectionIds = new Set(
    groupRepos.map((repo) => normalizeConnectionId(repo.connectionId))
  )
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnectionIds.has(normalizeConnectionId(repo.connectionId)))
  ]
}

export function findFolderWorkspaceCandidateRepos(
  state: FolderWorkspaceHostState,
  folderWorkspaceId: string
): Repo[] {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return []
  }
  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  return getFolderScopeCandidateRepos({
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId: normalizeConnectionId(workspace.connectionId ?? group?.connectionId),
    projectGroups: state.projectGroups,
    repos: state.repos
  })
}

export function resolveFolderWorkspaceHost(
  state: FolderWorkspaceHostState,
  folderWorkspaceId: string
): FolderWorkspaceHost {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return { kind: 'missing' }
  }
  const explicitHost = parseExecutionHostId(workspace.executionHostId)
  if (explicitHost) {
    return explicitHost.kind === 'ssh'
      ? { kind: 'ssh', targetId: explicitHost.targetId }
      : { kind: 'local' }
  }
  const scopeConnectionId = normalizeConnectionId(
    workspace.connectionId ??
      state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId
  )
  const candidateRepos = findFolderWorkspaceCandidateRepos(state, folderWorkspaceId)
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    const connectionId = normalizeConnectionId(repo.connectionId)
    if (connectionId) {
      connectionIds.add(connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (scopeConnectionId) {
    const hasDifferentSshConnection = [...connectionIds].some(
      (connectionId) => connectionId !== scopeConnectionId
    )
    return hasLocalRepo || hasDifferentSshConnection
      ? { kind: 'ambiguous' }
      : { kind: 'ssh', targetId: scopeConnectionId }
  }
  if (candidateRepos.length === 0 || connectionIds.size === 0) {
    return { kind: 'local' }
  }
  if (hasLocalRepo || connectionIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  return { kind: 'ssh', targetId: [...connectionIds][0] }
}
