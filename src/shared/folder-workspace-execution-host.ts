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
import { getRepoExecutionHostId, parseExecutionHostId } from './execution-host'

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

/**
 * The SSH target whose filesystem holds this repo's files, or `null` for anything else.
 *
 * SSH ownership has two spellings on a repo row — the legacy `connectionId` field and the unified
 * `executionHostId` — so reading the raw field sees only one of them and a row carrying only
 * `executionHostId: 'ssh:<target>'` reads as if it had no connection at all. Every comparison in
 * this file goes through here: the candidate filters decide which rows reach the resolver, so
 * reading raw in either place drops the row before the resolver can classify it.
 *
 * A non-SSH host falls back to the raw field so a `runtime:` row keeps contributing its nested
 * target exactly as it does today. That target is not this client's to dial, but changing it is a
 * separate defect with its own reasoning — see the note in `resolveFolderWorkspaceHost`.
 */
function getRepoScopeConnectionId(repo: Repo): string | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'ssh' ? host.targetId : normalizeConnectionId(repo.connectionId)
}

function getFolderScopeCandidateRepos(args: {
  folderPath: string
  projectGroupId: string
  connectionId: string | null
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): Repo[] {
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  // Classify each repo once. The previous pair of filters read every
  // projectGroupId twice before applying the same path predicate.
  const groupRepos: Repo[] = []
  const pathRepos: Repo[] = []
  for (const repo of args.repos) {
    const projectGroupId = repo.projectGroupId
    if (typeof projectGroupId === 'string' && groupIds.has(projectGroupId)) {
      groupRepos.push(repo)
    } else if (isPathInsideOrEqual(args.folderPath, repo.path)) {
      pathRepos.push(repo)
    }
  }
  if (args.connectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => getRepoScopeConnectionId(repo) === args.connectionId)
    ]
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  // Both sides resolved: comparing a resolved path repo against a raw group read would reintroduce
  // the same mismatch from the other direction.
  const groupConnectionIds = new Set(groupRepos.map(getRepoScopeConnectionId))
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnectionIds.has(getRepoScopeConnectionId(repo)))
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
    // A `runtime:` workspace deliberately answers `local`, and `FolderWorkspaceHost` has no runtime
    // variant to answer with instead. That omission is known: a runtime environment's own server
    // normalizes its work to `local`, and the nested SSH target on such a row is addressable only as
    // the pair (environmentId, targetId) — handing it to this client's SSH table would dial a
    // same-named box in the wrong namespace. Widening the type is its own change, not an oversight
    // here.
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
    const connectionId = getRepoScopeConnectionId(repo)
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
