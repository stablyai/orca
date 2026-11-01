// Share history-resume target eligibility and folder-workspace host resolution between desktop and mobile.

import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { isWslUncPath, parseWslUncPath } from './wsl-paths'
import { antigravitySessionOrigin } from './antigravity-session-origin'
import { getRepoIdFromWorktreeId } from './worktree/id'
import { parseWorkspaceKey } from './workspace-scope'
import { canResumeAiVaultSessionOnSshHost } from './ai-vault-ssh-resume-target'
import {
  findFolderWorkspaceCandidateRepos,
  type FolderHostCatalog,
  type FolderHostRepo
} from './folder-workspace-execution-host'

export type AiVaultResumeTargetStatus = 'local' | 'ssh' | 'runtime' | 'unknown'

type AiVaultResumeRepoOwner = Pick<FolderHostRepo, 'connectionId' | 'executionHostId'>

export function getAiVaultResumeRepoTargetStatus(
  repo: AiVaultResumeRepoOwner | null | undefined
): AiVaultResumeTargetStatus {
  if (!repo) {
    return 'unknown'
  }
  // SSH/WSL use normal PTY startup; runtime ownership requires executionHost because its connectionId stays null.
  return getAiVaultResumeExecutionHostTargetStatus(getRepoExecutionHostId(repo))
}

function isSupportedAiVaultResumeTargetStatus(status: AiVaultResumeTargetStatus): boolean {
  return status === 'local' || status === 'ssh' || status === 'runtime'
}

export function isWslStoredAiVaultSessionFile(sessionFilePath: string | null | undefined): boolean {
  return Boolean(sessionFilePath && isWslUncPath(sessionFilePath))
}

export function canResumeAiVaultSessionOnTarget(args: {
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
  targetStatus: AiVaultResumeTargetStatus
  targetExecutionHostId?: ExecutionHostId | null
  targetWslDistro?: string | null
}): boolean {
  const sessionExecutionHostId = normalizeExecutionHostId(args.sessionExecutionHostId)
  const targetExecutionHostId = normalizeExecutionHostId(args.targetExecutionHostId)
  const origin = args.sessionFilePath ? antigravitySessionOrigin(args.sessionFilePath) : null
  if (origin && origin !== 'antigravity-cli') {
    if (!isSupportedAiVaultResumeTargetStatus(args.targetStatus)) {
      return false
    }
    const sourceHost = sessionExecutionHostId ?? LOCAL_EXECUTION_HOST_ID
    const targetHost =
      targetExecutionHostId ?? (args.targetStatus === 'local' ? LOCAL_EXECUTION_HOST_ID : null)
    if (sourceHost !== targetHost) {
      // #6270's SSH/UNC labels do not prove this host owns the referenced file.
      return false
    }
    if (args.targetStatus === 'local' && args.targetWslDistro === undefined) {
      return false
    }
    const sourceWsl = args.sessionFilePath ? parseWslUncPath(args.sessionFilePath) : null
    if (sourceWsl) {
      return (
        args.targetStatus === 'local' &&
        Boolean(args.targetWslDistro) &&
        sourceWsl.distro.toLowerCase() === args.targetWslDistro?.toLowerCase()
      )
    }
    // File references require the original filesystem, unlike legacy ID resumes.
    return args.targetStatus !== 'local' || !args.targetWslDistro
  }
  if (args.targetStatus === 'runtime') {
    // Runtime session stores belong to one server; allow resumes only back onto that exact host.
    return Boolean(
      sessionExecutionHostId &&
      targetExecutionHostId &&
      sessionExecutionHostId === targetExecutionHostId
    )
  }
  if (!isSupportedAiVaultResumeTargetStatus(args.targetStatus)) {
    return false
  }
  if (args.targetStatus === 'ssh') {
    return canResumeAiVaultSessionOnSshHost({
      sessionFilePath: args.sessionFilePath,
      sessionExecutionHostId,
      targetExecutionHostId
    })
  }
  if (!isAiVaultSessionInWslNamespace(args.sessionFilePath, args.targetWslDistro)) {
    return false
  }
  if (sessionExecutionHostId && targetExecutionHostId) {
    return sessionExecutionHostId === targetExecutionHostId
  }
  return !sessionExecutionHostId || sessionExecutionHostId === LOCAL_EXECUTION_HOST_ID
}

/** Separate native/WSL local namespaces (#24408); undefined proves nothing and refuses nothing, while null means native. */
function isAiVaultSessionInWslNamespace(
  sessionFilePath: string | null | undefined,
  targetWslDistro: string | null | undefined
): boolean {
  if (targetWslDistro === undefined) {
    return true
  }
  const sourceWsl = sessionFilePath ? parseWslUncPath(sessionFilePath) : null
  if (!sourceWsl) {
    return !targetWslDistro
  }
  return sourceWsl.distro.toLowerCase() === targetWslDistro?.toLowerCase()
}

/** The workspaces a resume can target, and how to find a worktree's owning host and repo. */
export type AiVaultResumeWorkspaceCatalog<R extends FolderHostRepo & { id: string }> =
  FolderHostCatalog<R> & {
    findWorktree: (
      worktreeId: string
    ) => { hostId?: string | null; repoId?: string | null } | undefined
  }

export function getAiVaultResumeWorkspaceExecutionHostId<R extends FolderHostRepo & { id: string }>(
  catalog: AiVaultResumeWorkspaceCatalog<R>,
  workspaceId: string | null
): ExecutionHostId | null {
  if (!workspaceId) {
    return null
  }

  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type === 'folder') {
    return getAiVaultResumeFolderExecutionHostId(catalog, workspaceKey.folderWorkspaceId)
  }

  const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
  const worktree = catalog.findWorktree(worktreeId)
  const worktreeHostId = normalizeExecutionHostId(worktree?.hostId)
  if (worktreeHostId) {
    return worktreeHostId
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = catalog.repos.find((candidate) => candidate.id === repoId)
  return repo ? getRepoExecutionHostId(repo) : null
}

export function getAiVaultResumeWorkspaceTargetStatus<R extends FolderHostRepo & { id: string }>(
  catalog: AiVaultResumeWorkspaceCatalog<R>,
  workspaceId: string | null
): AiVaultResumeTargetStatus {
  if (!workspaceId) {
    return 'unknown'
  }

  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type === 'folder') {
    return getAiVaultResumeFolderTargetStatus(catalog, workspaceKey.folderWorkspaceId)
  }

  const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
  const worktree = catalog.findWorktree(worktreeId)
  const worktreeHost = getAiVaultResumeExecutionHostTargetStatus(worktree?.hostId)
  if (worktreeHost !== 'unknown') {
    return worktreeHost
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  return getAiVaultResumeRepoTargetStatus(catalog.repos.find((repo) => repo.id === repoId))
}

function getAiVaultResumeFolderTargetStatus<R extends FolderHostRepo>(
  catalog: FolderHostCatalog<R>,
  folderWorkspaceId: string
): AiVaultResumeTargetStatus {
  const workspace = catalog.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return 'unknown'
  }

  const group = catalog.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  const groupHostId = normalizeExecutionHostId(workspace.executionHostId ?? group?.executionHostId)
  if (groupHostId) {
    return getAiVaultResumeExecutionHostTargetStatus(groupHostId)
  }
  const explicitConnectionId = (workspace.connectionId ?? group?.connectionId ?? '').trim()
  if (explicitConnectionId) {
    return getAiVaultResumeExecutionHostTargetStatus(toSshExecutionHostId(explicitConnectionId))
  }

  return mergeAiVaultResumeExecutionHostTargetStatuses(
    findFolderWorkspaceCandidateRepos(catalog, folderWorkspaceId).map(getRepoExecutionHostId)
  )
}

function getAiVaultResumeFolderExecutionHostId<R extends FolderHostRepo>(
  catalog: FolderHostCatalog<R>,
  folderWorkspaceId: string
): ExecutionHostId | null {
  const workspace = catalog.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return null
  }

  const group = catalog.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  const groupHostId = normalizeExecutionHostId(workspace.executionHostId ?? group?.executionHostId)
  if (groupHostId) {
    return groupHostId
  }
  const explicitConnectionId = (workspace.connectionId ?? group?.connectionId ?? '').trim()
  if (explicitConnectionId) {
    return toSshExecutionHostId(explicitConnectionId)
  }
  return mergeAiVaultResumeExecutionHostIds(
    findFolderWorkspaceCandidateRepos(catalog, folderWorkspaceId).map(getRepoExecutionHostId)
  )
}

function getAiVaultResumeExecutionHostTargetStatus(
  hostId: string | null | undefined
): AiVaultResumeTargetStatus {
  return parseExecutionHostId(hostId)?.kind ?? 'unknown'
}

function mergeAiVaultResumeExecutionHostTargetStatuses(
  hostIds: readonly ExecutionHostId[]
): AiVaultResumeTargetStatus {
  if (hostIds.length === 0) {
    return 'local'
  }
  const statuses = hostIds.map(getAiVaultResumeExecutionHostTargetStatus)
  const uniqueStatuses = new Set(statuses)
  if (uniqueStatuses.has('runtime')) {
    return 'runtime'
  }
  return new Set(hostIds).size === 1 ? (statuses[0] ?? 'unknown') : 'unknown'
}

function mergeAiVaultResumeExecutionHostIds(
  hostIds: readonly ExecutionHostId[]
): ExecutionHostId | null {
  if (hostIds.length === 0) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const uniqueHostIds = new Set(hostIds)
  return uniqueHostIds.size === 1 ? (hostIds[0] ?? null) : null
}
