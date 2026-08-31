import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { worktreeRowMatchesMetaHost } from './worktrees/listing/worktree-meta-host-match'

type RequiredKey<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]

// Why: a present-but-undefined key in a spread ERASES the field. That is the
// intended wire signal for clearing optional metadata, but this protects required
// Worktree fields from disappearing in optimistic projections.
const ERASURE_PROTECTED_KEYS: Record<Extract<RequiredKey<Worktree>, keyof WorktreeMeta>, true> = {
  displayName: true,
  comment: true,
  linkedIssue: true,
  linkedPR: true,
  linkedLinearIssue: true,
  isArchived: true,
  isUnread: true,
  isPinned: true,
  sortOrder: true,
  lastActivityAt: true
}

export function withoutErasedRequiredWorktreeFields(
  updates: Partial<WorktreeMeta>
): Partial<WorktreeMeta> {
  const erased = Object.keys(ERASURE_PROTECTED_KEYS).filter(
    (key) => updates[key as keyof WorktreeMeta] === undefined && Object.hasOwn(updates, key)
  )
  if (erased.length === 0) {
    return updates
  }

  const next = { ...updates }
  for (const key of erased) {
    delete next[key as keyof WorktreeMeta]
  }
  return next
}

export function applyWorktreeUpdates(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string,
  rawUpdates: Partial<WorktreeMeta>,
  executionHostId?: ExecutionHostId
): Record<string, Worktree[]> {
  const updates = withoutErasedRequiredWorktreeFields(rawUpdates)
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const worktrees = worktreesByRepo[repoId]
  if (!worktrees) {
    return worktreesByRepo
  }

  let changed = false
  const nextWorktrees = worktrees.map((worktree) => {
    if (worktree.id !== worktreeId || !worktreeRowMatchesMetaHost(worktree, executionHostId)) {
      return worktree
    }

    changed = true
    return { ...worktree, ...updates }
  })
  if (!changed) {
    return worktreesByRepo
  }

  return { ...worktreesByRepo, [repoId]: nextWorktrees }
}
