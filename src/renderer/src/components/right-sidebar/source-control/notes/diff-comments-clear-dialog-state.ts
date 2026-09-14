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
  const noun = count === 1 ? 'note' : 'notes'
  if (pending.kind === 'all') {
    return `Clear ${count} ${noun} from this workspace?`
  }
  return `Clear ${count} ${noun} from ${pending.filePath}?`
}
