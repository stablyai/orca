import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { worktreeRowMatchesMetaHost } from '../listing/worktree-meta-host-match'
import { branchName } from '@/lib/source-control/branches/branch-name'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments/workspace-attachments'

type RequiredKey<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]

// Spread keys with undefined intentionally erase optional metadata; protect required Worktree fields from optimistic erasure.
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

/** One row with meta updates applied; returns the same row when every resulting field is unchanged. */
export function applyWorktreeRowUpdates<T extends Worktree>(
  worktree: T,
  updates: Partial<WorktreeMeta>
): T {
  // Rows store the pin as displayNameMode, so the meta flag itself never lands on the row.
  const { displayNameIsPinned, ...rowUpdates } = updates
  const next = { ...worktree, ...normalizeWorkspaceAttachmentUpdate(worktree, rowUpdates) }
  if (displayNameIsPinned !== undefined) {
    next.displayNameMode = displayNameIsPinned ? 'fixed' : 'automatic'
    if (displayNameIsPinned === false && !updates.displayName?.trim()) {
      const automaticName = branchName(next.branch)
      // A detached worktree has no branch-derived label; keep the old text until the host
      // projection supplies its repo/path fallback instead of flashing an empty sidebar row.
      next.displayName = automaticName || worktree.displayName
    }
  }
  const before = new Map(Object.entries(worktree))
  const fields = Object.entries(next)
  // A key on only one row changes the key count or misses in `before`.
  const unchanged =
    fields.length === before.size &&
    fields.every(([key, value]) => before.has(key) && before.get(key) === value)
  return unchanged ? worktree : next
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
    const next = applyWorktreeRowUpdates(worktree, updates)
    changed ||= next !== worktree
    return next
  })
  if (!changed) {
    return worktreesByRepo
  }

  return { ...worktreesByRepo, [repoId]: nextWorktrees }
}
