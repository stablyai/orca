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
import { isWslUncPath, parseWslUncPath } from '../../../shared/wsl-paths'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import { canResumeAiVaultSessionInExecutionContext } from '../../../shared/ai-vault-resume-context'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import { getFolderWorkspaceCandidateRepos } from './folder-workspace-connection'
import { getLocalAgentPreflightContext } from './local-preflight-context'

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
  return status === 'local' || status === 'ssh' || status === 'runtime'
}

export function isWslStoredAiVaultSessionFile(sessionFilePath: string | null | undefined): boolean {
  return Boolean(sessionFilePath && isWslUncPath(sessionFilePath))
}

export function canResumeAiVaultSessionOnTarget(args: {
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
  sessionAgent?: AiVaultAgent
  targetStatus: AiVaultResumeTargetStatus
  targetExecutionHostId?: ExecutionHostId | null
  targetWorkspacePath?: string | null
  targetWslDistro?: string | null
}): boolean {
  return canResumeAiVaultSessionInExecutionContext({
    agent: args.sessionAgent,
    sessionFilePath: args.sessionFilePath,
    sessionExecutionHostId: args.sessionExecutionHostId,
    targetStatus: args.targetStatus,
    targetExecutionHostId: args.targetExecutionHostId,
    targetWslDistro:
      args.targetWslDistro ?? parseWslUncPath(args.targetWorkspacePath ?? '')?.distro ?? null
  })
}

export function canResumeAiVaultSessionForWorkspace(args: {
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'> &
    Partial<Pick<AppState, 'activeRepoId' | 'activeWorktreeId' | 'projects' | 'settings'>>
  workspaceId: string
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
  sessionAgent?: AiVaultAgent
}): boolean {
  return canResumeAiVaultSessionOnTarget({
    sessionFilePath: args.sessionFilePath,
    sessionExecutionHostId: args.sessionExecutionHostId,
    sessionAgent: args.sessionAgent,
    targetStatus: getAiVaultResumeWorkspaceTargetStatus(args.state, args.workspaceId),
    targetExecutionHostId: getAiVaultResumeWorkspaceExecutionHostId(args.state, args.workspaceId),
    targetWorkspacePath: getAiVaultResumeWorkspacePath(args.state, args.workspaceId),
    targetWslDistro: getAiVaultResumeWorkspaceWslDistro(args.state, args.workspaceId)
  })
}

export function isUnsupportedAiVaultResumeRepo(
  repo: AiVaultResumeRepoOwner | null | undefined
): boolean {
  const status = getAiVaultResumeRepoTargetStatus(repo)
  return status !== 'unknown' && !isSupportedAiVaultResumeTargetStatus(status)
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
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo ?? {}).get(worktreeId)
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
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo ?? {}).get(worktreeId)
  const worktreeHost = getAiVaultResumeExecutionHostTargetStatus(worktree?.hostId)
  if (worktreeHost !== 'unknown') {
    return worktreeHost
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  return getAiVaultResumeRepoTargetStatus(state.repos.find((repo) => repo.id === repoId))
}

export function getAiVaultResumeWorkspacePath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  workspaceId: string
): string | null {
  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type === 'folder') {
    return (
      state.folderWorkspaces.find((workspace) => workspace.id === workspaceKey.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
  return getIndexedWorktreeMap(state.worktreesByRepo ?? {}).get(worktreeId)?.path ?? null
}

export function getAiVaultResumeWorkspaceWslDistro(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'> &
    Partial<
      Pick<AppState, 'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings'>
    >,
  workspaceId: string
): string | null {
  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type !== 'folder' && state.settings && state.projects && state.repos) {
    const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
    const context = getLocalAgentPreflightContext(
      state as AppState,
      undefined,
      undefined,
      worktreeId
    )
    if (context?.wslDistro) {
      return context.wslDistro
    }
  }
  return parseWslUncPath(getAiVaultResumeWorkspacePath(state, workspaceId) ?? '')?.distro ?? null
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
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
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
