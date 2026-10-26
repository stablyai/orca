import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWslUncPath, parseWslUncPath } from '../../../shared/wsl-paths'
import { antigravitySessionOrigin } from '../../../shared/antigravity-session-origin'
import { canResumeAiVaultSessionOnSshHost } from '../../../shared/ai-vault-ssh-resume-target'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import { getFolderWorkspaceCandidateRepos } from './folder-workspace-connection'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

export type AiVaultResumeTargetStatus = 'local' | 'ssh' | 'runtime' | 'unknown'

type AiVaultResumeRepoOwner = Pick<Repo, 'connectionId' | 'executionHostId'>

export function getAiVaultResumeRepoTargetStatus(
  repo: AiVaultResumeRepoOwner | null | undefined
): AiVaultResumeTargetStatus {
  if (!repo) {
    return 'unknown'
  }
  // SSH/WSL use normal PTY startup; runtime ownership requires executionHost because its connectionId stays null.
  return getAiVaultResumeExecutionHostTargetStatus(getRepoExecutionHostId(repo))
}

export function isSupportedAiVaultResumeTargetStatus(status: AiVaultResumeTargetStatus): boolean {
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

export function getAiVaultResumeWorkspaceExecutionHostId(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  workspaceId: string | null
): ExecutionHostId | null {
  if (!workspaceId) {
    return null
  }

  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type === 'folder') {
    return getAiVaultResumeFolderExecutionHostId(state, workspaceKey.folderWorkspaceId)
  }

  const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
  const worktree = getIndexedWorktreeMap(selectWorktreesByRepo(state) ?? {}).get(worktreeId)
  const worktreeHostId = normalizeExecutionHostId(worktree?.hostId)
  if (worktreeHostId) {
    return worktreeHostId
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos.find((candidate) => candidate.id === repoId)
  return repo ? getRepoExecutionHostId(repo) : null
}

export function getAiVaultResumeWorkspaceTargetStatus(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  workspaceId: string | null
): AiVaultResumeTargetStatus {
  if (!workspaceId) {
    return 'unknown'
  }

  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type === 'folder') {
    return getAiVaultResumeFolderTargetStatus(state, workspaceKey.folderWorkspaceId)
  }

  const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
  const worktree = getIndexedWorktreeMap(selectWorktreesByRepo(state) ?? {}).get(worktreeId)
  const worktreeHost = getAiVaultResumeExecutionHostTargetStatus(worktree?.hostId)
  if (worktreeHost !== 'unknown') {
    return worktreeHost
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  return getAiVaultResumeRepoTargetStatus(state.repos.find((repo) => repo.id === repoId))
}

function getAiVaultResumeFolderTargetStatus(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos'>,
  folderWorkspaceId: string
): AiVaultResumeTargetStatus {
  const workspace = selectFolderWorkspaces(state).find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return 'unknown'
  }

  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  const groupHostId = normalizeExecutionHostId(workspace.executionHostId ?? group?.executionHostId)
  if (groupHostId) {
    return getAiVaultResumeExecutionHostTargetStatus(groupHostId)
  }
  const explicitConnectionId = (workspace.connectionId ?? group?.connectionId ?? '').trim()
  if (explicitConnectionId) {
    return getAiVaultResumeExecutionHostTargetStatus(toSshExecutionHostId(explicitConnectionId))
  }

  return mergeAiVaultResumeExecutionHostTargetStatuses(
    getFolderWorkspaceCandidateRepos(state, folderWorkspaceId).map(getRepoExecutionHostId)
  )
}

function getAiVaultResumeFolderExecutionHostId(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos'>,
  folderWorkspaceId: string
): ExecutionHostId | null {
  const workspace = selectFolderWorkspaces(state).find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return null
  }

  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  const groupHostId = normalizeExecutionHostId(workspace.executionHostId ?? group?.executionHostId)
  if (groupHostId) {
    return groupHostId
  }
  const explicitConnectionId = (workspace.connectionId ?? group?.connectionId ?? '').trim()
  if (explicitConnectionId) {
    return toSshExecutionHostId(explicitConnectionId)
  }
  return mergeAiVaultResumeExecutionHostIds(
    getFolderWorkspaceCandidateRepos(state, folderWorkspaceId).map(getRepoExecutionHostId)
  )
}

function getAiVaultResumeExecutionHostTargetStatus(
  hostId: ExecutionHostId | null | undefined
): AiVaultResumeTargetStatus {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    return 'unknown'
  }
  if (parsed.kind === 'local') {
    return 'local'
  }
  return parsed.kind
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
