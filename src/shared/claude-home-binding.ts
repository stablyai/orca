import { isWindowsAbsolutePathLike } from './cross-platform-path'
import {
  getProjectGroupExecutionHostId,
  getRepoExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import { getExecutionHostIdFromWorktreeHostIdentity } from './worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from './worktree/id'
import { normalizeWorkspaceSessionKeyToWorkspaceId, parseWorkspaceKey } from './workspace-scope'

export type ResolvedClaudeHomeBinding = {
  configDir: string
  /** The group that supplied it — may be an ancestor of the workspace's own group. */
  groupId: string
}

/**
 * A persisted binding, or null when the value does not name one fixed directory on some host.
 *
 * Deliberately not `normalizeClaudeConfigDir`: `src/main/rate-limits/service/service-types.ts`
 * exports that name for a different contract (it rewrites separators and accepts a relative path),
 * and both are importable from main, so a wrong auto-import would be silent in either direction.
 *
 * Syntax decides it, never the running platform: groups sync between clients and remote hosts, so
 * a macOS client must keep a Windows host's `C:\…` or `\\server\share` binding intact. Rejected
 * along with plain relative paths are the drive-relative spellings `\Users\alice` and `C:alice`,
 * which resolve against the *process's* current drive on Windows and are ordinary relative
 * filenames on POSIX — one binding would then mean a different home per session.
 */
export function parseClaudeConfigDirBinding(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  return isWindowsAbsolutePathLike(trimmed) || trimmed.startsWith('/') ? trimmed : null
}

type HostStampedRow = { connectionId?: string | null; executionHostId?: string | null }

/**
 * Why host-scoped: `groups` and `repos` are host-qualified catalogs that hold rows from every
 * execution host at once, so the same id can appear twice. A config dir is a filesystem path on
 * exactly one host (`docs/reference/ssh-execution-boundary.md`), so only the row stamped for the
 * workspace's host may answer.
 *
 * The one fallback is a row that states no ownership at all — a legacy row predating host
 * stamping, which may be on any host. A row stamped for a *different* host is never a fallback:
 * answering with it hands one host's filesystem path to a session on another, which is the silent
 * wrong-identity failure this binding exists to prevent.
 */
export function findRowForHost<T extends HostStampedRow>(
  rows: readonly T[],
  matchesId: (row: T) => boolean,
  hostOf: (row: T) => ExecutionHostId,
  hostId: ExecutionHostId | null | undefined
): T | undefined {
  let unstamped: T | undefined
  for (const row of rows) {
    if (!matchesId(row)) {
      continue
    }
    if (hostId && hostOf(row) === hostId) {
      return row
    }
    if (!row.executionHostId && !row.connectionId) {
      unstamped ??= row
    }
  }
  return unstamped
}

/** Nearest binding walking up `parentGroupId`. Bounded so a cycle that survived normalization ends. */
export function resolveClaudeHomeBindingForGroup(
  groups: readonly ProjectGroup[],
  groupId: string | null | undefined,
  executionHostId?: ExecutionHostId | null
): ResolvedClaudeHomeBinding | null {
  if (!groupId) {
    return null
  }
  const visited = new Set<string>()
  let currentId: string | null | undefined = groupId
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const current = currentId
    const group: ProjectGroup | undefined = findRowForHost(
      groups,
      (candidate) => candidate.id === current,
      getProjectGroupExecutionHostId,
      executionHostId
    )
    if (!group) {
      return null
    }
    const configDir = parseClaudeConfigDirBinding(group.claudeConfigDir)
    if (configDir) {
      return { configDir, groupId: group.id }
    }
    // A group tree lives on one host, so every hop stays scoped to the host the walk started on.
    currentId = group.parentGroupId
  }
  return null
}

type WorkspaceGroupLookup = {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceId: string
  /** Disambiguates a workspace id that exists on more than one host; else read off the id itself. */
  executionHostId?: ExecutionHostId | null
}

type WorkspaceGroupRef = { groupId: string; executionHostId: ExecutionHostId | null }

function resolveWorkspaceGroupRef(input: WorkspaceGroupLookup): WorkspaceGroupRef | null {
  // Why the canonical unwrapper: a workspace id reaches here as a WorkspaceKey, a host-qualified
  // identity (`ssh:target|repo::path`) or a bare id, and a missed shape reads as "unbound" —
  // indistinguishable from "no binding configured", which is the silent-wrong-account failure.
  const hostId =
    input.executionHostId ?? getExecutionHostIdFromWorktreeHostIdentity(input.workspaceId) ?? null
  const workspaceId = normalizeWorkspaceSessionKeyToWorkspaceId(input.workspaceId)
  const scope = parseWorkspaceKey(workspaceId)
  const folderWorkspaceId = scope?.type === 'folder' ? scope.folderWorkspaceId : workspaceId
  const folderWorkspace = findRowForHost(
    input.folderWorkspaces,
    (workspace) => workspace.id === folderWorkspaceId,
    getRepoExecutionHostId,
    hostId
  )
  if (folderWorkspace) {
    return folderWorkspace.projectGroupId
      ? {
          groupId: folderWorkspace.projectGroupId,
          executionHostId: hostId ?? getRepoExecutionHostId(folderWorkspace)
        }
      : null
  }
  const repoId = getRepoIdFromWorktreeId(
    scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  )
  const repo = findRowForHost(
    input.repos,
    (candidate) => candidate.id === repoId,
    getRepoExecutionHostId,
    hostId
  )
  return repo?.projectGroupId
    ? { groupId: repo.projectGroupId, executionHostId: hostId ?? getRepoExecutionHostId(repo) }
    : null
}

export function resolveProjectGroupIdForWorkspace(input: WorkspaceGroupLookup): string | null {
  return resolveWorkspaceGroupRef(input)?.groupId ?? null
}

export function resolveClaudeHomeBindingForWorkspace(
  input: WorkspaceGroupLookup & { groups: readonly ProjectGroup[] }
): ResolvedClaudeHomeBinding | null {
  const ref = resolveWorkspaceGroupRef(input)
  return ref
    ? resolveClaudeHomeBindingForGroup(input.groups, ref.groupId, ref.executionHostId)
    : null
}
