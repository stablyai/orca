/** The host decisions shared by the scalar folder resolver and its batched index, so the two
 *  cannot drift: a row's pins, its scope repos' summary, and the one qualifying row of an ID. */

import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeHostPart,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type {
  FolderHostCatalog,
  FolderHostRepo,
  FolderHostWorkspace,
  FolderWorkspaceHost,
  QualifiedFolderHostState,
  QualifiedFolderWorkspaceResult
} from './folder-workspace-execution-host'

/** Resolve legacy connectionId and unified SSH ownership in both candidate filters and the resolver; raw reads can discard SSH-only rows early.
 * Non-SSH hosts retain raw connectionId for runtime-nested targets, which require the environment to dial. */
export function getRepoScopeConnectionId(repo: FolderHostRepo): string | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'ssh' ? host.targetId : normalizeHostPart(repo.connectionId)
}

/** What host resolution needs from a scope's repos: any local one, and their one or several SSH connections. */
export type FolderScopeRepos = {
  hasLocalRepo: boolean
  connectionId: string | null
  mixedConnections: boolean
}

export const NO_FOLDER_SCOPE_REPOS: FolderScopeRepos = {
  hasLocalRepo: false,
  connectionId: null,
  mixedConnections: false
}

export function folderScopeRepo(repo: FolderHostRepo): FolderScopeRepos {
  const connectionId = getRepoScopeConnectionId(repo)
  return { hasLocalRepo: !connectionId, connectionId, mixedConnections: false }
}

export function mergeFolderScopeRepos(a: FolderScopeRepos, b: FolderScopeRepos): FolderScopeRepos {
  return {
    hasLocalRepo: a.hasLocalRepo || b.hasLocalRepo,
    connectionId: a.connectionId ?? b.connectionId,
    mixedConnections:
      a.mixedConnections ||
      b.mixedConnections ||
      (!!a.connectionId && !!b.connectionId && a.connectionId !== b.connectionId)
  }
}

/** A row's host from its own or its groups' pins, before any repo is read; otherwise the
 *  connection its scope's repos must agree on. */
export function pinnedFolderRowHost(
  workspace: FolderHostWorkspace,
  groups: readonly FolderHostCatalog['projectGroups'][number][]
): { host: FolderWorkspaceHost } | { scopeConnectionId: string | null } {
  const groupHosts = new Set(groups.map(getRepoExecutionHostId))
  const explicitHost =
    parseExecutionHostId(workspace.executionHostId) ??
    (!normalizeHostPart(workspace.connectionId) &&
    groupHosts.size === 1 &&
    groups.some(
      (group) =>
        parseExecutionHostId(group.executionHostId) || normalizeHostPart(group.connectionId)
    )
      ? parseExecutionHostId([...groupHosts][0])
      : null)
  const scopeConnections = new Set(groups.map(getRepoScopeConnectionId))
  const scopeConnectionId =
    normalizeHostPart(workspace.connectionId) ??
    (scopeConnections.size === 1 ? [...scopeConnections][0] : null)
  switch (explicitHost?.kind) {
    case 'ssh':
      return { host: { kind: 'ssh', targetId: explicitHost.targetId } }
    case 'runtime':
      return {
        host: {
          kind: 'runtime',
          environmentId: explicitHost.environmentId,
          sshTargetId: scopeConnectionId
        }
      }
    case 'local':
      return { host: { kind: 'local' } }
    case undefined:
      break
  }
  if (!normalizeHostPart(workspace.connectionId) && groupHosts.size > 1) {
    return { host: { kind: 'ambiguous' } }
  }
  return { scopeConnectionId }
}

export function classifyFolderScope(
  scopeConnectionId: string | null,
  repos: FolderScopeRepos
): FolderWorkspaceHost {
  if (scopeConnectionId) {
    return repos.hasLocalRepo ||
      repos.mixedConnections ||
      (repos.connectionId !== null && repos.connectionId !== scopeConnectionId)
      ? { kind: 'ambiguous' }
      : { kind: 'ssh', targetId: scopeConnectionId }
  }
  if (!repos.connectionId) {
    return { kind: 'local' }
  }
  return repos.hasLocalRepo || repos.mixedConnections
    ? { kind: 'ambiguous' }
    : { kind: 'ssh', targetId: repos.connectionId }
}

/** The one row of an ID that resolves to the required host; a row whose host cannot be derived
 *  makes the ID ambiguous. Shared by the scalar resolver and the batched index. */
export function qualifyFolderWorkspaceRows<W extends FolderHostWorkspace>(
  rows: readonly W[],
  groupsOf: (workspace: W) => QualifiedFolderHostState['projectGroups'],
  hostOf: (workspace: W) => FolderWorkspaceHost,
  complete: boolean,
  requiredHostId?: ExecutionHostId
): QualifiedFolderWorkspaceResult<W> {
  let underivable = false
  const matches = rows.flatMap((workspace) => {
    const explicit =
      parseExecutionHostId(workspace.executionHostId) ||
      normalizeHostPart(workspace.connectionId) ||
      groupsOf(workspace)?.some(
        (group) =>
          parseExecutionHostId(group.executionHostId) || normalizeHostPart(group.connectionId)
      )
    const host =
      !explicit && (!complete || !workspace.folderPath)
        ? { kind: 'ambiguous' as const }
        : hostOf(workspace)
    const hostId: ExecutionHostId | null =
      host.kind === 'local'
        ? LOCAL_EXECUTION_HOST_ID
        : host.kind === 'ssh'
          ? toSshExecutionHostId(host.targetId)
          : host.kind === 'runtime'
            ? toRuntimeExecutionHostId(host.environmentId)
            : null
    underivable ||= hostId === null
    return hostId && (!requiredHostId || hostId === requiredHostId)
      ? [
          {
            workspace,
            hostId,
            connectionId:
              host.kind === 'ssh'
                ? host.targetId
                : host.kind === 'runtime'
                  ? host.sshTargetId
                  : null
          }
        ]
      : []
  })
  return matches.length === 1
    ? { kind: 'selected' as const, value: matches[0] }
    : {
        kind:
          rows.length && (underivable || matches.length > 1)
            ? ('ambiguous' as const)
            : ('missing' as const)
      }
}
