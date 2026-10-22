import type { AppState } from '../types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { getWorktreeIdFromVisitKey, getWorktreeVisitKey } from '@/lib/worktree-visit-recency'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { omitSparsePresetsForRepos } from '../slices/sparse-presets'
import { repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { selectProjectHostSetups, selectProjects, selectRepos } from '../project-catalog-selectors'
import { mergeProjectCompatibilityForHostRepoChange } from './repo-catalog-identity'
import { twinSelectionPatch } from './repo-removal-host-twin-attribution'
import type { collectRemovedHostTwins } from './repo-removal-host-twin-teardown'

export function worktreeBelongsToHost(worktree: { hostId?: string }, hostId: string): boolean {
  return (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
}

/** The store after a project's row on `ownerHostId` is gone: its worktrees, visits and selection. */
export function removedProjectStatePatch(
  s: AppState,
  projectId: string,
  ownerHostId: ExecutionHostId,
  worktreeIds: readonly string[],
  twins: ReturnType<typeof collectRemovedHostTwins>
): Partial<AppState> {
  const nextWorktrees = { ...s.worktreesByRepo }
  const remainingWorktrees = (nextWorktrees[projectId] ?? []).filter(
    (worktree) => !worktreeBelongsToHost(worktree, ownerHostId)
  )
  if (remainingWorktrees.length > 0) {
    nextWorktrees[projectId] = remainingWorktrees
  } else {
    delete nextWorktrees[projectId]
  }
  const nextDetectedWorktrees = { ...s.detectedWorktreesByRepo }
  const detected = nextDetectedWorktrees[projectId]
  if (detected) {
    const remainingDetected = detected.worktrees.filter(
      (worktree) => !worktreeBelongsToHost(worktree, ownerHostId)
    )
    if (remainingDetected.length > 0) {
      nextDetectedWorktrees[projectId] = { ...detected, worktrees: remainingDetected }
    } else {
      delete nextDetectedWorktrees[projectId]
    }
  }
  // Why no tab/layout/editor writes here: purgeWorktreeTerminalState above already dropped them.
  const worktreeIdSet = new Set(worktreeIds)
  const removedVisitKeys = new Set(
    worktreeIds.map((worktreeId) => getWorktreeVisitKey(worktreeId, ownerHostId))
  )
  const nextRepos = selectRepos(s).filter(
    (r) => !repoMatchesHostIdentity(r, projectId, ownerHostId)
  )
  // Why: when no sibling host owns this id, drop every worktree timestamp (unhydrated SSH ones would otherwise never prune); else stay host-scoped.
  const repoIdFullyRemoved = !nextRepos.some((r) => r.id === projectId)
  let nextLastVisitedAtByWorktreeId = s.lastVisitedAtByWorktreeId
  for (const id of Object.keys(s.lastVisitedAtByWorktreeId)) {
    const rawId = getWorktreeIdFromVisitKey(id)
    if (
      (ownerHostId && removedVisitKeys.has(id)) ||
      (!ownerHostId && worktreeIdSet.has(rawId)) ||
      (repoIdFullyRemoved && getRepoIdFromWorktreeId(rawId) === projectId)
    ) {
      if (nextLastVisitedAtByWorktreeId === s.lastVisitedAtByWorktreeId) {
        nextLastVisitedAtByWorktreeId = { ...s.lastVisitedAtByWorktreeId }
      }
      delete nextLastVisitedAtByWorktreeId[id]
    }
  }
  const survivingRepoIds = new Set(nextRepos.map((r) => r.id))
  const removedRepoIds = selectRepos(s)
    .filter((r) => !survivingRepoIds.has(r.id))
    .map((r) => r.id)
  return {
    ...(ORCA_SIDEBAR_INPUTS_IS_MAIN
      ? {}
      : {
          repos: nextRepos,
          ...mergeProjectCompatibilityForHostRepoChange({
            previous: {
              projects: selectProjects(s),
              projectHostSetups: selectProjectHostSetups(s)
            },
            nextRepos,
            hostId: ownerHostId
          })
        }),
    // Why: drop removed repos' sparse-preset maps so they don't outlive the repo for the whole session.
    ...omitSparsePresetsForRepos(s, removedRepoIds),
    activeRepoId: s.activeRepoId === projectId ? null : s.activeRepoId,
    ...twinSelectionPatch(s, twins.twinHostIds, ownerHostId),
    filterRepoIds: s.filterRepoIds.filter((id) => id !== projectId),
    worktreesByRepo: nextWorktrees,
    detectedWorktreesByRepo: nextDetectedWorktrees,
    lastVisitedAtByWorktreeId: nextLastVisitedAtByWorktreeId,
    folderWorkspacePathStatuses: {},
    sortEpoch: s.sortEpoch + 1,
    // Why: removing the last repo must reset activeView + clear activeWorktreeId so App renders Landing, not an empty settings/terminal pane.
    ...(nextRepos.length === 0
      ? {
          activeView: 'terminal' as const,
          activeWorktreeId: null,
          activeWorkspaceKey: null,
          activeWorkspaceExecutionHostId: null,
          activeRepoId: null
        }
      : {})
  }
}
