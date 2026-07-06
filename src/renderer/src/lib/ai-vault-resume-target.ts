import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { AppState } from '@/store/types'
import { getFolderWorkspaceCandidateRepos } from './folder-workspace-connection'

export type AiVaultResumeTargetStatus = 'local' | 'ssh' | 'runtime' | 'unknown'

type AiVaultResumeRepoOwner = Pick<Repo, 'connectionId' | 'executionHostId'>

export function getAiVaultResumeRepoTargetStatus(
  repo: AiVaultResumeRepoOwner | null | undefined
): AiVaultResumeTargetStatus {
  if (!repo) {
    return 'unknown'
  }
  // Why: SSH and WSL targets use the normal PTY startup path. Runtime-owned
  // repos intentionally keep connectionId null, so check the execution host.
  return getAiVaultResumeExecutionHostTargetStatus(getRepoExecutionHostId(repo))
}

export function isSupportedAiVaultResumeRepo(
  repo: AiVaultResumeRepoOwner | null | undefined
): boolean {
  return isSupportedAiVaultResumeTargetStatus(getAiVaultResumeRepoTargetStatus(repo))
}

export function isSupportedAiVaultResumeTargetStatus(status: AiVaultResumeTargetStatus): boolean {
  return status === 'local' || status === 'ssh'
}

export function isWslStoredAiVaultSessionFile(sessionFilePath: string | null | undefined): boolean {
  return Boolean(sessionFilePath && isWslUncPath(sessionFilePath))
}

export function canResumeAiVaultSessionOnTarget(args: {
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
  targetStatus: AiVaultResumeTargetStatus
  targetExecutionHostId?: ExecutionHostId | null
}): boolean {
  if (!isSupportedAiVaultResumeTargetStatus(args.targetStatus)) {
    return false
  }
  const sessionExecutionHostId = normalizeExecutionHostId(args.sessionExecutionHostId)
  const targetExecutionHostId = normalizeExecutionHostId(args.targetExecutionHostId)
  if (sessionExecutionHostId) {
    if (targetExecutionHostId) {
      if (sessionExecutionHostId === targetExecutionHostId) {
        return true
      }
      // Why: SSH-to-local-WSL setups (#6270) tag the session 'local' but the
      // file lives under a WSL UNC path reachable from any SSH shell into this
      // machine, so we bypass the exact host-id match for that case.
      return (
        sessionExecutionHostId === LOCAL_EXECUTION_HOST_ID &&
        args.targetStatus === 'ssh' &&
        isWslStoredAiVaultSessionFile(args.sessionFilePath)
      )
    }
    if (sessionExecutionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return false
    }
  }
  // Why: vault sessions are scanned from this machine's disk (host home dirs
  // plus local WSL homes). An SSH shell can only reach the WSL-stored ones
  // (SSH-to-local-WSL setups, #6270); host-stored session files do not exist
  // on a remote filesystem, so queuing a resume there is guaranteed to fail.
  if (args.targetStatus === 'ssh') {
    return isWslStoredAiVaultSessionFile(args.sessionFilePath)
  }
  return true
}

export function isUnsupportedAiVaultResumeRepo(
  repo: AiVaultResumeRepoOwner | null | undefined
): boolean {
  return getAiVaultResumeRepoTargetStatus(repo) === 'runtime'
}

export function getAiVaultResumeWorktreeTargetStatus(args: {
  worktreeId: string | null
  worktrees: readonly { id: string; repoId: string; hostId?: ExecutionHostId }[]
  repos: readonly AiVaultResumeRepoOwnerWithId[]
}): AiVaultResumeTargetStatus {
  if (!args.worktreeId) {
    return 'unknown'
  }
  const worktree = args.worktrees.find((candidate) => candidate.id === args.worktreeId)
  if (!worktree) {
    return 'unknown'
  }
  const worktreeHost = getAiVaultResumeExecutionHostTargetStatus(worktree.hostId)
  if (worktreeHost !== 'unknown') {
    return worktreeHost
  }
  return getAiVaultResumeRepoTargetStatus(
    args.repos.find((candidate) => candidate.id === worktree.repoId)
  )
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
  const worktree = Object.values(state.worktreesByRepo ?? {})
    .flat()
    .find((candidate) => candidate.id === worktreeId)
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
  const worktree = Object.values(state.worktreesByRepo ?? {})
    .flat()
    .find((candidate) => candidate.id === worktreeId)
  const worktreeHost = getAiVaultResumeExecutionHostTargetStatus(worktree?.hostId)
  if (worktreeHost !== 'unknown') {
    return worktreeHost
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  return getAiVaultResumeRepoTargetStatus(state.repos.find((repo) => repo.id === repoId))
}

type AiVaultResumeRepoOwnerWithId = AiVaultResumeRepoOwner & { id: string }

function getAiVaultResumeFolderTargetStatus(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos'>,
  folderWorkspaceId: string
): AiVaultResumeTargetStatus {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return 'unknown'
  }

  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  const groupHostId = normalizeExecutionHostId(group?.executionHostId)
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
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return null
  }

  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  const groupHostId = normalizeExecutionHostId(group?.executionHostId)
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
