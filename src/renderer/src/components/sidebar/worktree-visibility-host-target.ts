import { getProjectSectionRepoLookup } from '../../../../shared/project-section-reveal'
import { getProjectCheckoutPathKey } from '../../../../shared/project-grouping'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import { getRepoHostSummaries } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { useCallback } from 'react'
import type { AppState } from '@/store/types'
import { findRepoForHost, getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { selectDetectedWorktreesByRepo } from '@/store/workspace-record-selectors'

export function resolveWorktreeVisibilityHostTarget(
  state: Pick<AppState, 'repos' | 'settings' | 'detectedWorktreesByRepo'>,
  repoId: string,
  modalHostId: unknown
) {
  return resolveWorktreeVisibilityTargets(state, repoId, modalHostId, undefined)
}

export function resolveWorktreeVisibilityTargets(
  state: Pick<AppState, 'repos' | 'settings' | 'detectedWorktreesByRepo'>,
  repoId: string,
  modalHostId: unknown,
  recoveryTargets: unknown
) {
  const requestedHostId =
    typeof modalHostId === 'string' ? parseExecutionHostId(modalHostId)?.id : undefined
  const lookup = getProjectSectionRepoLookup(state.repos)
  const source = requestedHostId
    ? lookup.get(`${requestedHostId}\0${repoId}`)
    : findRepoForHost(state.repos, repoId, { settings: state.settings })
  const partitions = partitionDetectedWorktreesByHost(
    state.repos,
    selectDetectedWorktreesByRepo(state)
  )
  const requested: { repoId: string; hostId: ExecutionHostId }[] = []
  if (Array.isArray(recoveryTargets)) {
    for (const target of recoveryTargets) {
      if (
        typeof target !== 'object' ||
        target === null ||
        !('repoId' in target) ||
        !('hostId' in target) ||
        typeof target.repoId !== 'string' ||
        typeof target.hostId !== 'string'
      ) {
        continue
      }
      const host = parseExecutionHostId(target.hostId)?.id
      if (host) {
        requested.push({ repoId: target.repoId, hostId: host })
      }
    }
  } else if (source) {
    requested.push({ repoId: source.id, hostId: getRepoExecutionHostId(source) })
  }
  const scans = new Map<string, { physical: string; scope: string; scopes: Set<string> }>()
  const physicalKey = (repo: Repo) =>
    getProjectCheckoutPathKey({
      id: repo.id,
      repoId: repo.id,
      projectId: getProjectIdentityKey(repo),
      hostId: getRepoExecutionHostId(repo),
      connectionId: repo.connectionId,
      executionHostId: repo.executionHostId,
      path: repo.path,
      displayName: repo.displayName,
      setupMethod: repo.projectHostSetupMethod ?? 'legacy-repo'
    })
  const addScan = (physical: string, scope: string) => {
    const scan = scans.get(physical)
    if (scan) {
      scan.scopes.add(scope)
      return false
    }
    scans.set(physical, { physical, scope, scopes: new Set([scope]) })
    return true
  }
  const entries = requested.flatMap((target) => {
    const scope = getRepoHostIdentityForParts(target.repoId, target.hostId)
    const repo = lookup.get(scope)
    if (repo && !isGitRepoKind(repo)) {
      return []
    }
    if (repo && !addScan(physicalKey(repo), scope)) {
      return []
    }
    return [{ ...target, scope, repo, detected: partitions.get(scope) }]
  })
  const sourceScope = source ? getRepoHostIdentity(source) : `${requestedHostId ?? ''}\0${repoId}`
  if (source) {
    addScan(physicalKey(source), sourceScope)
  }
  return {
    entries,
    scanTargets: [...scans.values()].map((scan) => ({ ...scan, scopes: [...scan.scopes] })),
    repo: source,
    detected: partitions.get(sourceScope),
    requestedHostId,
    scope: sourceScope
  }
}

export function useWorktreeVisibilityHostActions(
  fetchWorktrees: AppState['fetchWorktrees'],
  updateRepo: AppState['updateRepo'],
  requestedHostId: ExecutionHostId | undefined
) {
  const refreshTargetRepo = useCallback(
    (repoId: string, options?: { requireAuthoritative?: boolean }) =>
      fetchWorktrees(repoId, {
        ...options,
        ...(requestedHostId ? { executionHostId: requestedHostId } : {})
      }),
    [fetchWorktrees, requestedHostId]
  )
  const updateTargetRepo = useCallback(
    (repoId: string, updates: Parameters<AppState['updateRepo']>[1]) =>
      requestedHostId
        ? updateRepo(repoId, updates, { hostId: requestedHostId })
        : updateRepo(repoId, updates),
    [requestedHostId, updateRepo]
  )
  return { refreshTargetRepo, updateTargetRepo }
}

export function getDetectedWorktreeOwnerHost(
  worktree: Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>,
  summary: { count: number; onlyHostId?: ExecutionHostId } | undefined
): ExecutionHostId {
  return worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    : (worktree.hostId ?? (summary?.count === 1 ? summary.onlyHostId : undefined) ?? 'local')
}

export function partitionDetectedWorktreesByHost(
  repos: readonly Repo[],
  detectedByRepo: Readonly<Record<string, DetectedWorktreeListResult | undefined>>
): Map<string, DetectedWorktreeListResult> {
  const summaries = getRepoHostSummaries(repos)
  const result = new Map<string, DetectedWorktreeListResult>()
  for (const repo of repos) {
    const detected = detectedByRepo[repo.id]
    const identity = getRepoHostIdentity(repo)
    if (detected && !result.has(identity)) {
      result.set(identity, { ...detected, worktrees: [] })
    }
  }
  for (const [repoId, detected] of Object.entries(detectedByRepo)) {
    if (!detected) {
      continue
    }
    const summary = summaries.get(repoId)
    for (const worktree of detected.worktrees) {
      const identity = getRepoHostIdentityForParts(
        repoId,
        getDetectedWorktreeOwnerHost(worktree, summary)
      )
      result.get(identity)?.worktrees.push(worktree)
    }
  }
  return result
}
