import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import { getFolderWorkspaceCandidateRepos } from './folder-workspace-connection'

export type AiVaultResumeTargetStatus = 'local' | 'non-local' | 'unknown'

type AiVaultResumeRepoOwner = Pick<Repo, 'connectionId' | 'executionHostId'>

export function getAiVaultResumeRepoTargetStatus(
  repo: AiVaultResumeRepoOwner | null | undefined
): AiVaultResumeTargetStatus {
  if (!repo) {
    return 'unknown'
  }
  // Why: runtime-owned repos intentionally keep connectionId null, so resume
  // availability must follow the execution owner instead of SSH state alone.
  return repo.connectionId || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
    ? 'non-local'
    : 'local'
}

export function isLocalAiVaultResumeRepo(repo: AiVaultResumeRepoOwner | null | undefined): boolean {
  return getAiVaultResumeRepoTargetStatus(repo) === 'local'
}

export function isNonLocalAiVaultResumeRepo(
  repo: AiVaultResumeRepoOwner | null | undefined
): boolean {
  return getAiVaultResumeRepoTargetStatus(repo) === 'non-local'
}

export function getAiVaultResumeWorktreeTargetStatus(args: {
  worktreeId: string | null
  worktrees: readonly { id: string; repoId: string }[]
  repos: readonly AiVaultResumeRepoOwnerWithId[]
}): AiVaultResumeTargetStatus {
  if (!args.worktreeId) {
    return 'unknown'
  }
  const worktree = args.worktrees.find((candidate) => candidate.id === args.worktreeId)
  if (!worktree) {
    return 'unknown'
  }
  return getAiVaultResumeRepoTargetStatus(
    args.repos.find((candidate) => candidate.id === worktree.repoId)
  )
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
  if (
    workspace.connectionId ||
    group?.connectionId ||
    (groupHostId && groupHostId !== LOCAL_EXECUTION_HOST_ID)
  ) {
    return 'non-local'
  }

  return mergeAiVaultResumeTargetStatuses(
    getFolderWorkspaceCandidateRepos(state, folderWorkspaceId).map(getAiVaultResumeRepoTargetStatus)
  )
}

function mergeAiVaultResumeTargetStatuses(
  statuses: readonly AiVaultResumeTargetStatus[]
): AiVaultResumeTargetStatus {
  if (statuses.length === 0) {
    return 'local'
  }
  const uniqueStatuses = new Set(statuses)
  if (uniqueStatuses.size === 1) {
    return statuses[0] ?? 'unknown'
  }
  return uniqueStatuses.has('unknown') ? 'unknown' : 'non-local'
}
