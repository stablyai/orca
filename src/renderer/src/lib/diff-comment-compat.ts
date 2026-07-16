import type { DiffComment, DiffCommentSource, PRComment } from '../../../shared/types'
import type { DecoratedDiffComment } from '../components/diff-comments/useDiffCommentDecorator'
import type { AppState } from '../store/types'

export function getDiffCommentSource(comment: Pick<DiffComment, 'source'>): DiffCommentSource {
  return comment.source === 'markdown' ? 'markdown' : 'diff'
}

export function isDiffComment(comment: Pick<DiffComment, 'source'>): boolean {
  return getDiffCommentSource(comment) === 'diff'
}

export function isMarkdownComment(comment: Pick<DiffComment, 'source'>): boolean {
  return getDiffCommentSource(comment) === 'markdown'
}

export function getDiffCommentLineLabel(
  comment: Pick<DiffComment, 'lineNumber' | 'startLine'>,
  compact = false
): string {
  if (comment.startLine !== undefined && comment.startLine !== comment.lineNumber) {
    return compact
      ? `L${comment.startLine}-L${comment.lineNumber}`
      : `Lines ${comment.startLine}-${comment.lineNumber}`
  }
  return compact ? `L${comment.lineNumber}` : `Line ${comment.lineNumber}`
}

// Why: transform PRComment to DecoratedDiffComment for inline display in diff views.
// PR comments from the checks view include file path and line information for inline
// review comments. This utility maps them to the format expected by the diff comment
// decorator so they can be shown inline in both view-all diff and single file diff views.
export function prCommentToDecoratedDiffComment(
  prComment: PRComment,
  worktreeId: string
): DecoratedDiffComment | null {
  // Only inline review comments have path information
  if (!prComment.path) {
    return null
  }

  // PR comments use 1-based line numbers, matching DiffComment format
  const lineNumber = prComment.line
  if (!lineNumber) {
    return null
  }

  return {
    id: `pr-${prComment.id}`,
    worktreeId,
    filePath: prComment.path,
    lineNumber,
    startLine: prComment.startLine,
    body: prComment.body,
    createdAt: new Date(prComment.createdAt).getTime(),
    author: prComment.author,
    authorAvatarUrl: prComment.authorAvatarUrl,
    createdAtLabel: new Date(prComment.createdAt).toLocaleString(),
    url: prComment.url,
    canDelete: false, // PR comments are managed remotely
    canEdit: false, // PR comments are managed remotely
    source: 'diff', // PR comments are always shown in diff context
    side: 'modified' // PR comments are always on the modified side in v1
  }
}

// Why: filter and transform PR comments for a specific file, converting them to
// DecoratedDiffComment format for inline display in diff views. Normalizes slashes,
// leading slashes, and casing to ensure robust matching across git/GitHub path formats.
export function prCommentsToDecoratedDiffComments(
  prComments: readonly PRComment[],
  filePath: string,
  worktreeId: string
): DecoratedDiffComment[] {
  const normFilePath = filePath.replace(/\\/g, '/').replace(/^\//, '').toLowerCase()
  return prComments
    .filter((comment) => {
      const normCommentPath = comment.path?.replace(/\\/g, '/').replace(/^\//, '').toLowerCase()
      return normCommentPath === normFilePath && comment.line != null
    })
    .map((comment) => prCommentToDecoratedDiffComment(comment, worktreeId))
    .filter((comment): comment is DecoratedDiffComment => comment != null)
}

// Why: fetch PR comments for a linked PR from the store and return them in the
// DecoratedDiffComment format for inline display in diff views. This extracts
// the store access logic to keep DiffViewer.tsx under the 400-line limit.
export function getPRInlineCommentsFromStore(
  state: AppState,
  worktreeId: string | undefined,
  relativePath: string
): DecoratedDiffComment[] {
  if (!worktreeId) {
    return []
  }

  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return []
  }

  let linkedPR = worktree.linkedPR
  if (!linkedPR && worktree.branch) {
    const keys = Object.keys(state.prCache)
    const targetKey = keys.find(
      (k) =>
        k.toLowerCase().includes(worktree.repoId.toLowerCase()) &&
        k.endsWith(`::${worktree.branch}`)
    )
    const cachedPR = targetKey ? state.prCache[targetKey]?.data : null
    if (cachedPR) {
      linkedPR = cachedPR.number
    }
  }

  if (!linkedPR) {
    return []
  }

  // Why: commentsCache keys may be prefixed by host/runtime environment
  // scope or contain the full prRepo name in the middle. Match keys
  // dynamically to find the correct entry regardless of caching scopes.
  const keys = Object.keys(state.commentsCache)
  const targetKey = keys.find(
    (k) =>
      k.toLowerCase().includes(worktree.repoId.toLowerCase()) &&
      k.includes('::pr-comments::') &&
      k.endsWith(`::${linkedPR}`)
  )
  const prComments = (targetKey ? state.commentsCache[targetKey]?.data : null) ?? []

  return prCommentsToDecoratedDiffComments(prComments, relativePath, worktreeId)
}

// Why: combine local diff comments with PR inline comments for display in diff views.
// This merges the worktree's persisted diff comments with PR review comments from
// the linked PR, both in DecoratedDiffComment format.
export function combineDiffComments(
  localComments: DiffComment[],
  prComments: DecoratedDiffComment[]
): DecoratedDiffComment[] {
  return [...localComments, ...prComments] as DecoratedDiffComment[]
}
