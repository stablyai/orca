import type { Repo } from '../repository/repo-types'
import { getRepoExecutionHostId, isRepoOnCatalogHost } from '../execution-host/execution-host'
import { isFolderRepo } from '../repository/repo-kind'
import {
  normalizeWorkspaceCleanupRules,
  normalizeRepoWorkspaceCleanupPolicy,
  type WorkspaceCleanupRules,
  type RepoWorkspaceCleanupPolicy
} from './workspace-cleanup-policy'
import type { WorkspaceCleanupPreview } from './workspace-cleanup-run'

export type WorkspaceCleanupPolicyState = {
  repoId: string | null
  rules: WorkspaceCleanupRules
  projects: { id: string; hostId: string; policy: RepoWorkspaceCleanupPolicy | null }[]
}
export type WorkspaceCleanupPolicyGuard = {
  id: string
  expiresAt: number
  expected: WorkspaceCleanupPolicyState
  requireReservation?: true
}
export type WorkspaceCleanupGuardedUpdate = {
  workspaceCleanupGuard?: WorkspaceCleanupPolicyGuard
}
export type WorkspaceCleanupPolicyChange =
  | { scope: 'global'; rules: WorkspaceCleanupRules }
  | { scope: 'project'; repoId: string; policy: RepoWorkspaceCleanupPolicy | null }
export type WorkspaceCleanupPolicyPreviewRequest = {
  change: WorkspaceCleanupPolicyChange
  expected: WorkspaceCleanupPolicyState
}
export type WorkspaceCleanupPolicyRead = {
  state: WorkspaceCleanupPolicyState
  expiresAt: number
  protocol: 3
  pendingWrites?: boolean
}
export type WorkspaceCleanupPolicyComparison = {
  current: WorkspaceCleanupPreview
  next: WorkspaceCleanupPreview
  read: WorkspaceCleanupPolicyRead
}

/** Owns immutable values: persistence normalizes in place, so store objects cannot be expectations. */
export function captureWorkspaceCleanupPolicyState(
  settings: { workspaceCleanupPolicy?: WorkspaceCleanupRules },
  repos: readonly Repo[],
  repoId: string | null
): WorkspaceCleanupPolicyState {
  const projects = repos
    .filter(
      (repo) => isRepoOnCatalogHost(repo) && !isFolderRepo(repo) && (!repoId || repo.id === repoId)
    )
    .map((repo) => ({
      id: repo.id,
      hostId: getRepoExecutionHostId(repo),
      policy: normalizeRepoWorkspaceCleanupPolicy(repo.workspaceCleanupPolicy) ?? null
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.hostId.localeCompare(b.hostId))
  if (repoId && projects.length !== 1) {
    throw new Error('workspace_cleanup_project_unavailable')
  }
  return {
    repoId,
    rules: normalizeWorkspaceCleanupRules(settings.workspaceCleanupPolicy),
    projects
  }
}
