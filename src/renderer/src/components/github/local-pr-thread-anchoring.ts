import type { DecoratedDiffComment } from '@/components/diff-comments/decorated-diff-comment'
import {
  buildOutdatedReviewThreadItems,
  buildReviewThreadItems,
  reviewThreadKey
} from './pr-review-thread-grouping'
import type { PRComment } from '../../../../shared/github/comment-types'

// GitHub anchors review threads to lines of the PR head. A local worktree can
// sit ahead of (or diverge from) that head, so before rendering a thread inline
// we verify the anchor line's content still matches what GitHub commented on —
// "outdated over misplaced". Drifted threads join the per-file outdated group.

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** Content of the commented line at the PR head: the last line of the thread's anchor hunk, sans diff marker.
 *  A trailing `\ No newline at end of file` marker fails the compare on purpose — outdated beats misplaced. */
export function anchorLineFromHunk(diffHunk: string | undefined): string | null {
  if (!diffHunk) {
    return null
  }
  const lines = diffHunk.split('\n')
  const last = stripTrailingCr(lines.at(-1) ?? '')
  if (!last || last.startsWith('@@')) {
    return null
  }
  return last.slice(1)
}

export type LocalThreadAnchorContext = {
  /** Rendered right-side content of the local diff; null while the section is still loading. */
  modifiedContent: string | null
  /** Local head equals the PR head — anchors are exact by construction. */
  headMatchesPrHead: boolean
}

function threadAnchorsCleanly(
  root: PRComment,
  { modifiedContent, headMatchesPrHead }: LocalThreadAnchorContext
): boolean {
  // LEFT-side threads target the PR base file; the local diff's panes show
  // merge-base and worktree content, so there is no line to anchor to.
  if (root.diffSide === 'LEFT') {
    return false
  }
  const anchorLine = anchorLineFromHunk(root.diffHunk)
  if (anchorLine !== null && modifiedContent !== null && typeof root.line === 'number') {
    const localLine = modifiedContent.split('\n')[root.line - 1]
    return localLine !== undefined && stripTrailingCr(localLine) === anchorLine
  }
  return headMatchesPrHead
}

/**
 * Split a file's PR review threads into inline-safe and outdated groups for a
 * local worktree diff. Threads GitHub already marks outdated stay outdated;
 * the rest must pass the anchor-content check to render inline.
 */
export function splitLocalThreadsForFile(args: {
  comments: readonly PRComment[]
  path: string
  repoId: string
  prNumber: number
  context: LocalThreadAnchorContext
}): { inline: DecoratedDiffComment[]; outdated: DecoratedDiffComment[] } {
  const fileComments = args.comments.filter((comment) => comment.path === args.path)
  if (fileComments.length === 0) {
    return { inline: [], outdated: [] }
  }
  // Anchor checks read the thread root's hunk; replies inherit the verdict via threadId.
  const driftedThreads = new Set<string>()
  for (const comment of fileComments) {
    if (comment.isOutdated) {
      continue
    }
    // Why: LEFT-side threads target the base file and can never anchor locally, hunk or not.
    if (comment.diffSide === 'LEFT') {
      driftedThreads.add(reviewThreadKey(comment))
      continue
    }
    if (comment.diffHunk !== undefined && !threadAnchorsCleanly(comment, args.context)) {
      driftedThreads.add(reviewThreadKey(comment))
    }
  }
  // Threads whose root never arrived with a hunk (e.g. older GHES) fall back to the head check.
  const rootsByThread = new Set(
    fileComments
      .filter((comment) => comment.diffHunk !== undefined)
      .map((comment) => reviewThreadKey(comment))
  )
  if (!args.context.headMatchesPrHead) {
    for (const comment of fileComments) {
      const key = reviewThreadKey(comment)
      if (!comment.isOutdated && !rootsByThread.has(key)) {
        driftedThreads.add(key)
      }
    }
  }
  const marked = fileComments.map((comment) =>
    driftedThreads.has(reviewThreadKey(comment)) ? { ...comment, isOutdated: true } : comment
  )
  return {
    inline: buildReviewThreadItems(marked, args.repoId, args.prNumber),
    outdated: buildOutdatedReviewThreadItems(marked, args.repoId, args.prNumber)
  }
}

/** splitLocalThreadsForFile plus the worktree restamp both diff surfaces need. */
export function anchorLocalThreadsForFile(
  args: Parameters<typeof splitLocalThreadsForFile>[0] & { worktreeId: string }
): { inline: DecoratedDiffComment[]; outdated: DecoratedDiffComment[] } {
  const split = splitLocalThreadsForFile(args)
  return {
    // Why: the zone decorator drops comments stamped with a foreign worktree id.
    inline: split.inline.map((thread) => ({ ...thread, worktreeId: args.worktreeId })),
    outdated: split.outdated
  }
}
