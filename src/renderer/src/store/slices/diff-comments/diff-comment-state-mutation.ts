import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { findCopyRows } from './worktree-diff-comments-selector'
import { findOwnedFolder, type DiffCommentOwner } from './diff-comment-owner'
import type { DiffCommentMutation } from './diff-comment-persistence'
import type { FolderNoteScope } from './folder-note-actions'

// Why: derive the next list inside the `set` updater so concurrent writes can't clobber each other via a stale closure.
export function mutateDiffComments(
  set: Parameters<StateCreator<AppState>>[0],
  owner: DiffCommentOwner,
  mutate: (existing: DiffComment[]) => DiffComment[] | null,
  scope?: FolderNoteScope
): DiffCommentMutation | null {
  const worktreeId = owner.worktreeId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let previous: DiffComment[] | undefined
  let next: DiffComment[] | null = null
  set((s) => {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      if (owner.kind !== 'folder') {
        return s
      }
      const target = findOwnedFolder(s, owner)
      if (!target) {
        return s
      }
      previous = target.diffComments
      const computed = mutate(previous ?? [])
      if (computed === null) {
        return s
      }
      next = computed
      return {
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace === target ? { ...workspace, diffComments: computed } : workspace
        )
      }
    }
    if (owner.kind !== 'worktree') {
      return s
    }
    const repoList = s.worktreesByRepo[repoId]
    const rows = findCopyRows(s, worktreeId, owner.authority)
    if (!repoList || rows.length === 0) {
      return s
    }
    previous = rows.at(-1)?.diffComments
    const computed = mutate(previous ?? [])
    if (computed === null) {
      return s
    }
    next = computed
    const nextList: Worktree[] = repoList.map((w) =>
      rows.includes(w) ? { ...w, diffComments: computed } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
  if (next === null) {
    return null
  }
  return { owner, previous, next, ...(scope ? { scope } : {}) }
}

// Why: on IPC-write failure, roll back optimistic state so the renderer matches disk (identity-guarded below).
export function rollback(
  set: Parameters<StateCreator<AppState>>[0],
  worktreeId: string,
  previous: DiffComment[] | undefined,
  { next: expectedCurrent, owner }: DiffCommentMutation
): void {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  set((s) => {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      if (owner.kind !== 'folder') {
        return s
      }
      const target = findOwnedFolder(s, owner)
      if (!target || target.diffComments !== expectedCurrent) {
        return s
      }
      return {
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace === target ? { ...workspace, diffComments: previous } : workspace
        )
      }
    }
    const repoList = s.worktreesByRepo[repoId]
    if (!repoList) {
      return s
    }
    // Rollback only rows still holding this mutation’s array; later mutations and untouched twins must survive.
    const targets =
      owner.kind === 'worktree'
        ? findCopyRows(s, worktreeId, owner.authority).filter(
            (w) => w.diffComments === expectedCurrent
          )
        : []
    // Removed worktrees return before remapping to avoid pointless identity churn/notifications.
    if (targets.length === 0) {
      return s
    }
    const nextList: Worktree[] = repoList.map((w) =>
      targets.includes(w) ? { ...w, diffComments: previous } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
}
