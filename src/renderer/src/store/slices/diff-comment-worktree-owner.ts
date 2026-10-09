import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { getWorktreeInstanceId } from '../../../../shared/worktree/identity'
import {
  resolveWorktreeOperationRoute,
  settingsForWorktreeOperationRoute,
  type WorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import { getRepoIdFromWorktreeId } from './worktree-helpers'
import { persistWorktreeMeta } from './worktrees/metadata/worktree-meta-persist'

export type DiffCommentWorktreeOwner = { worktree: Worktree; route: WorktreeOperationRoute }

function worktreesForRoute(state: AppState, worktreeId: string, route: WorktreeOperationRoute) {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return (state.worktreesByRepo[repoId] ?? []).filter((row) => {
    if (row.id !== worktreeId) {
      return false
    }
    const exact = resolveExactWorktreeRoute(state, row)
    if (exact.kind === 'resolved') {
      return (
        exact.route.executionHostId === route.executionHostId &&
        exact.route.runtimeEnvironmentId === route.runtimeEnvironmentId
      )
    }
    return exact.kind === 'missing'
  })
}

export function captureDiffCommentWorktreeOwner(
  state: AppState,
  worktreeId: string
): DiffCommentWorktreeOwner | undefined {
  const route = resolveWorktreeOperationRoute(state, worktreeId)
  if (!route) {
    return undefined
  }
  const candidates = worktreesForRoute(state, worktreeId, route)
  return candidates.length === 1 ? { worktree: candidates[0], route } : undefined
}

export function currentDiffCommentWorktree(
  state: AppState,
  owner: DiffCommentWorktreeOwner | undefined
): Worktree | undefined {
  if (!owner) {
    return undefined
  }
  const captured = owner.worktree
  const candidates = worktreesForRoute(state, captured.id, owner.route)
  const current = candidates.length === 1 ? candidates[0] : undefined
  return current &&
    current.runtimeOwnerEnvironmentId === captured.runtimeOwnerEnvironmentId &&
    (!getWorktreeInstanceId(captured) ||
      getWorktreeInstanceId(current) === getWorktreeInstanceId(captured))
    ? current
    : undefined
}

export function diffCommentWorktreeQueueKey(owner: DiffCommentWorktreeOwner): string {
  return JSON.stringify([
    owner.route.runtimeEnvironmentId,
    owner.worktree.identity?.key ?? owner.route.executionHostId,
    getWorktreeInstanceId(owner.worktree) ?? owner.worktree.id
  ])
}

export function persistDiffCommentWorktree(
  state: AppState,
  owner: DiffCommentWorktreeOwner,
  diffComments: DiffComment[]
): Promise<void> {
  const worktree = owner.worktree
  return persistWorktreeMeta(
    settingsForWorktreeOperationRoute(state.settings, owner.route),
    worktree.id,
    { diffComments },
    worktree.identity?.executionHostId ??
      worktree.hostId ??
      owner.route.executionHostId ??
      undefined,
    worktree.identity?.key,
    getWorktreeInstanceId(worktree)
  )
}
