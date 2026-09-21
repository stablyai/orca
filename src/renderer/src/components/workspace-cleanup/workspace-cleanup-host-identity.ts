import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  WorkspaceSpaceWorktree,
  WorkspaceSpaceWorktreeMeasurement
} from '../../../../shared/workspace-space-types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupHostIdentity } from '../../../../shared/workspace-cleanup-host-identity'

export {
  getWorkspaceCleanupCandidateHostId,
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity,
  getWorkspaceCleanupIdentityWorktreeId,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'

/** Structural subset of `Worktree` kept in sync with the persisted source. */
export type WorkspaceCleanupWorktreeFacts = Pick<Worktree, 'id'> &
  Partial<
    Pick<
      Worktree,
      | 'repoId'
      | 'workspaceStatus'
      | 'isArchived'
      | 'isPinned'
      | 'isUnread'
      | 'comment'
      | 'hostId'
      | 'branch'
      | 'createdAt'
      | 'linkedWorkItem'
      | 'linkedLinearIssue'
      | 'linkedIssue'
      | 'locked'
      | 'prunable'
    >
  >

function countIds<Row extends { worktreeId: string }>(
  rows: readonly Row[],
  include: (row: Row) => boolean = () => true
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (include(row)) {
      counts.set(row.worktreeId, (counts.get(row.worktreeId) ?? 0) + 1)
    }
  }
  return counts
}

export function countWorkspaceCleanupCandidateIds(
  candidates: readonly Pick<WorkspaceCleanupCandidate, 'worktreeId'>[]
): Map<string, number> {
  return countIds(candidates)
}

/** Only `ok` scans carry a trustworthy byte count; everything else stays unsized. */
export function buildWorkspaceCleanupSizeIndex(
  worktrees:
    | readonly (WorkspaceSpaceWorktree | WorkspaceSpaceWorktreeMeasurement)[]
    | null
    | undefined,
  candidates?: readonly Pick<
    WorkspaceCleanupCandidate,
    'connectionId' | 'executionHostId' | 'worktreeId'
  >[]
): Map<string, number> {
  const index = new Map<string, number>()
  const candidateCounts = candidates ? countWorkspaceCleanupCandidateIds(candidates) : null
  const legacyCounts = countIds(
    worktrees ?? [],
    (entry) => !normalizeExecutionHostId(entry.executionHostId)
  )
  for (const entry of worktrees ?? []) {
    if (entry.status === 'ok' && Number.isFinite(entry.sizeBytes)) {
      const hostId = normalizeExecutionHostId(entry.executionHostId)
      if (hostId) {
        index.set(getWorkspaceCleanupHostIdentity(hostId, entry.worktreeId), entry.sizeBytes)
      } else if (
        legacyCounts.get(entry.worktreeId) === 1 &&
        (!candidateCounts || candidateCounts.get(entry.worktreeId) === 1)
      ) {
        index.set(entry.worktreeId, entry.sizeBytes)
      }
    }
  }
  return index
}

export function buildWorkspaceCleanupWorktreeIndex(
  worktreesByRepo: Readonly<Record<string, readonly WorkspaceCleanupWorktreeFacts[]>>,
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[] = []
): Map<string, WorkspaceCleanupWorktreeFacts> {
  const index = new Map<string, WorkspaceCleanupWorktreeFacts>()
  const repoHostsById = new Map<string, Set<ExecutionHostId>>()
  for (const repo of repos) {
    const hosts = repoHostsById.get(repo.id) ?? new Set<ExecutionHostId>()
    hosts.add(getRepoExecutionHostId(repo))
    repoHostsById.set(repo.id, hosts)
  }
  const legacyCounts = new Map<string, number>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (!normalizeExecutionHostId(worktree.hostId)) {
        legacyCounts.set(worktree.id, (legacyCounts.get(worktree.id) ?? 0) + 1)
      }
    }
  }
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      const explicitHostId = normalizeExecutionHostId(worktree.hostId)
      const repoHosts = worktree.repoId ? repoHostsById.get(worktree.repoId) : undefined
      const derivedHostId = repoHosts?.size === 1 ? [...repoHosts][0] : null
      const hostId =
        explicitHostId ?? (legacyCounts.get(worktree.id) === 1 ? derivedHostId : undefined)
      if (hostId) {
        index.set(getWorkspaceCleanupHostIdentity(hostId, worktree.id), worktree)
      }
    }
  }
  return index
}
