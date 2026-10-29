import { translate } from '@/i18n/i18n'

export type PendingDiffCommentsClear =
  | { kind: 'all'; worktreeId: string }
  | { kind: 'file'; worktreeId: string; filePath: string }

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
    return count === 1
      ? translate(
          'auto.components.right.sidebar.SourceControl.clearNotesFromWorkspace_one',
          'Clear {{count}} note from this workspace?',
          {
            count
          }
        )
      : translate(
          'auto.components.right.sidebar.SourceControl.clearNotesFromWorkspace_other',
          'Clear {{count}} notes from this workspace?',
          {
            count
          }
        )
  }
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.clearNotesFromFile_one',
        'Clear {{count}} note from {{path}}?',
        {
          count,
          path: pending.filePath
        }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.clearNotesFromFile_other',
        'Clear {{count}} notes from {{path}}?',
        {
          count,
          path: pending.filePath
        }
      )
}
