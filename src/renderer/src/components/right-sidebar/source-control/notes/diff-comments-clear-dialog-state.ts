import type { DiffCommentOwner } from '@/store/diff-comment-owner'
import { translate } from '@/i18n/i18n'

/** A clear confirmation on the copy shown when it opened; `count` stands in once that copy is gone. */
export type PendingDiffCommentsClear =
  | { kind: 'all'; worktreeId: string; owner: DiffCommentOwner; count: number }
  | { kind: 'file'; worktreeId: string; owner: DiffCommentOwner; filePath: string; count: number }

type DiffCommentWithPath = {
  filePath: string
}

export function countPendingDiffCommentsClear(
  pending: PendingDiffCommentsClear | null,
  activeWorktreeId: string | null | undefined,
  comments: readonly DiffCommentWithPath[]
): number {
  if (!pending || pending.worktreeId !== activeWorktreeId) {
    return 0
  }
  if (pending.kind === 'all') {
    return comments.length
  }
  return comments.filter((comment) => comment.filePath === pending.filePath).length
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
  count: number
): string {
  if (!pending) {
    return ''
  }
  if (pending.kind === 'all') {
    return translate(
      'auto.components.right.sidebar.SourceControl.clearNotesFromWorkspace',
      'Clear {{count}} notes from this workspace?',
      { count, defaultValue_one: 'Clear {{count}} note from this workspace?' }
    )
  }
  return translate(
    'auto.components.right.sidebar.SourceControl.clearNotesFromFile',
    'Clear {{count}} notes from {{path}}?',
    { count, path: pending.filePath, defaultValue_one: 'Clear {{count}} note from {{path}}?' }
  )
}
