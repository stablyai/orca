import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Worktree } from '../../../../shared/worktree/types'

type RequiredKey<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]

// Why: a present-but-undefined key in a spread ERASES the field. That is the
// intended wire signal for clearing optional metadata (pushTarget), but on a
// field Worktree declares required it produced a live `displayName: undefined`
// that crashed the worktree palette (crash a1f81ea1). Typed off Worktree so a
// newly-required field is protected automatically.
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
