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
): { rows: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>; changed: boolean } {
  // Why filter rows by host predicate, never by row id: worktree ids are `repoId::path` and
  // host-independent, so a sibling host publishing the same raw id at the same path shares the id.
  const twin: { repoId: string; hostId: string } | undefined =
    deletedRepo && deletedHostId && !removedRepoIds.includes(deletedRepo.id)
      ? { repoId: deletedRepo.id, hostId: deletedHostId }
      : undefined
  const twinDeletedHostRows = twin
    ? [
        ...(state.worktreesByRepo[twin.repoId] ?? []),
        ...(state.detectedWorktreesByRepo[twin.repoId]?.worktrees ?? [])
      ].filter((worktree) => worktreeBelongsToHost(worktree, twin.hostId))
    : []
  const touchesRemovedBucket = removedRepoIds.some(
    (id) => id in state.worktreesByRepo || id in state.detectedWorktreesByRepo
  )
  if (!touchesRemovedBucket && twinDeletedHostRows.length === 0) {
    return {
      rows: {
        worktreesByRepo: state.worktreesByRepo,
        detectedWorktreesByRepo: state.detectedWorktreesByRepo
      },
      changed: false
    }
  }
  const nextWorktreesByRepo = { ...state.worktreesByRepo }
  const nextDetectedWorktreesByRepo = { ...state.detectedWorktreesByRepo }
  for (const id of removedRepoIds) {
    delete nextWorktreesByRepo[id]
    delete nextDetectedWorktreesByRepo[id]
  }
  if (twin) {
    const remaining = (nextWorktreesByRepo[twin.repoId] ?? []).filter(
      (worktree) => !worktreeBelongsToHost(worktree, twin.hostId)
    )
    if (remaining.length > 0) {
      nextWorktreesByRepo[twin.repoId] = remaining
    } else {
      delete nextWorktreesByRepo[twin.repoId]
    }
    const detected = nextDetectedWorktreesByRepo[twin.repoId]
    if (detected) {
      const remainingDetected = detected.worktrees.filter(
        (worktree) => !worktreeBelongsToHost(worktree, twin.hostId)
      )
      if (remainingDetected.length > 0) {
        nextDetectedWorktreesByRepo[twin.repoId] = { ...detected, worktrees: remainingDetected }
      } else {
        delete nextDetectedWorktreesByRepo[twin.repoId]
      }
    }
  }
  return {
    rows: {
      worktreesByRepo: nextWorktreesByRepo,
      detectedWorktreesByRepo: nextDetectedWorktreesByRepo
    },
    changed: true
  }
}
