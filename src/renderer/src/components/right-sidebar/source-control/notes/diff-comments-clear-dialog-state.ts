import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** A clear confirmation for the exact notes listed when it opened; notes added later stay. */
export type PendingDiffCommentsClear =
  | { kind: 'all'; worktreeId: string; owner: DiffCommentOwner; ids: readonly string[] }
  | {
      kind: 'file'
      worktreeId: string
      owner: DiffCommentOwner
      filePath: string
      ids: readonly string[]
    }

/** How many captured notes still exist; `comments` is null once that copy is gone, which keeps the count. */
export function countPendingDiffCommentsClear(
  pending: PendingDiffCommentsClear | null,
  activeWorktreeId: string | null | undefined,
  comments: readonly { id: string }[] | null
): number {
  if (!pending || pending.worktreeId !== activeWorktreeId) {
    return 0
  }
  if (!comments) {
    return pending.ids.length
  }
  const present = new Set(comments.map((comment) => comment.id))
  return pending.ids.filter((id) => present.has(id)).length
}

export function resolvePendingDiffCommentsClear(args: {
  pending: PendingDiffCommentsClear | null
  activeWorktreeId: string | null | undefined
  pendingCount: number
  isClearing: boolean
}): PendingDiffCommentsClear | null {
  const { activeWorktreeId, isClearing, pending, pendingCount } = args
  if (!pending || isClearing) {
    return pending
  }
  if (pending.worktreeId !== activeWorktreeId || pendingCount === 0) {
    return null
  }
  return pending
}

export function formatPendingDiffCommentsClearDescription(
  pending: PendingDiffCommentsClear | null,
  t: Translate = translate
): string {
  if (!pending) {
    return ''
  }
  const count = pending.ids.length
  if (pending.kind === 'all') {
    return t(
      'auto.components.right.sidebar.SourceControl.clearNotesFromWorkspace',
      'Clear {{count}} notes from this workspace?',
      { count, defaultValue_one: 'Clear {{count}} note from this workspace?' }
    )
  }
  return t(
    'auto.components.right.sidebar.SourceControl.clearNotesFromFile',
    'Clear {{count}} notes from {{path}}?',
    { count, path: pending.filePath, defaultValue_one: 'Clear {{count}} note from {{path}}?' }
  )
}
