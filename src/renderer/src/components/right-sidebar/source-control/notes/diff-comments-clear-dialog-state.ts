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
