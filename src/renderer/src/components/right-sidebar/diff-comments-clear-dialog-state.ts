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
  // Why: scope and plurality both affect sentence grammar, so each combination
  // is translated as a complete confirmation question.
  if (pending.kind === 'all') {
    return count === 1
      ? translate(
          'auto.components.right.sidebar.diff.comments.clear.dialog.state.f07232e970',
          'Clear {{count}} note from this workspace?',
          { count }
        )
      : translate(
          'auto.components.right.sidebar.diff.comments.clear.dialog.state.d10b0441e0',
          'Clear {{count}} notes from this workspace?',
          { count }
        )
  }
  return count === 1
    ? translate(
        'auto.components.right.sidebar.diff.comments.clear.dialog.state.bd98da62a0',
        'Clear {{count}} note from {{value0}}?',
        { count, value0: pending.filePath }
      )
    : translate(
        'auto.components.right.sidebar.diff.comments.clear.dialog.state.edd639023e',
        'Clear {{count}} notes from {{value0}}?',
        { count, value0: pending.filePath }
      )
}
