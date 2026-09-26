import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { worktreeBelongsToHost } from '../repos/repo-removal'

// Why: deleteProjectHostSetup removes the repo from `repos` itself, so a later repos:changed
// refetch no longer sees the removal and the deleted repo's sidebar rows would linger under an
// "Unknown" header. Prune them the way removeProject does: whole buckets for repo ids that no
// host publishes anymore, host-scoped rows when a sibling host still shares the raw id.
export function pruneRemovedRepoWorktreeRows(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  removedRepoIds: readonly string[],
  deletedRepo: Pick<Repo, 'id'> | undefined,
  deletedHostId: string | null
): Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'> {
  let twinRepoId: string | null = null
  let twinHostId: string | null = null
  if (deletedRepo && deletedHostId && !removedRepoIds.includes(deletedRepo.id)) {
    twinRepoId = deletedRepo.id
    twinHostId = deletedHostId
  }
  const deletedHostRowIds = new Set(
    twinRepoId && twinHostId
      ? [
          ...(state.worktreesByRepo[twinRepoId] ?? []),
          ...(state.detectedWorktreesByRepo[twinRepoId]?.worktrees ?? [])
        ]
          .filter((worktree) => worktreeBelongsToHost(worktree, twinHostId))
          .map((worktree) => worktree.id)
      : []
  )
  const touchesRemovedBucket = removedRepoIds.some(
    (id) => id in state.worktreesByRepo || id in state.detectedWorktreesByRepo
  )
  if (!touchesRemovedBucket && deletedHostRowIds.size === 0) {
    return state
  }
  const nextWorktreesByRepo = { ...state.worktreesByRepo }
  const nextDetectedWorktreesByRepo = { ...state.detectedWorktreesByRepo }
  for (const id of removedRepoIds) {
    delete nextWorktreesByRepo[id]
    delete nextDetectedWorktreesByRepo[id]
  }
  if (twinRepoId && twinHostId) {
    const remaining = (nextWorktreesByRepo[twinRepoId] ?? []).filter(
      (worktree) => !deletedHostRowIds.has(worktree.id)
    )
    if (remaining.length > 0) {
      nextWorktreesByRepo[twinRepoId] = remaining
    } else {
      delete nextWorktreesByRepo[twinRepoId]
    }
    const detected = nextDetectedWorktreesByRepo[twinRepoId]
    if (detected) {
      const remainingDetected = detected.worktrees.filter(
        (worktree) => !deletedHostRowIds.has(worktree.id)
      )
      if (remainingDetected.length > 0) {
        nextDetectedWorktreesByRepo[twinRepoId] = { ...detected, worktrees: remainingDetected }
      } else {
        delete nextDetectedWorktreesByRepo[twinRepoId]
      }
    }
  }
  return {
    worktreesByRepo: nextWorktreesByRepo,
    detectedWorktreesByRepo: nextDetectedWorktreesByRepo
  }
}
