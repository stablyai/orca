import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { DecoratedDiffComment } from '@/components/diff-comments/decorated-diff-comment'
import { anchorLocalThreadsForFile } from '@/components/github/local-pr-thread-anchoring'
import { useLocalPRReviewThreads } from '@/components/github/use-local-pr-review-threads'
import { enrichInlineCommentsWithSuggestionTargets } from './diff-section-review-threads'

const EMPTY_THREADS: { inline: DecoratedDiffComment[]; outdated: DecoratedDiffComment[] } = {
  inline: [],
  outdated: []
}

/**
 * Read-only review threads of the worktree's linked PR, anchored against a
 * single local diff file. Threads whose anchor line drifted from the PR head
 * land in `outdated` instead of rendering on a wrong line.
 */
export function useLinkedPRReviewThreads(args: {
  worktreeId: string | undefined
  enabled: boolean
  relativePath: string
  modifiedContent: string | null
}): { inline: DecoratedDiffComment[]; outdated: DecoratedDiffComment[] } {
  const { worktreeId, enabled, relativePath, modifiedContent } = args
  const active = enabled && !!worktreeId
  const localPRThreads = useLocalPRReviewThreads(worktreeId, active)
  const localHeadOid = useAppStore((s) =>
    active && worktreeId ? (s.gitBranchCompareSummaryByWorktree[worktreeId]?.headOid ?? null) : null
  )
  const { comments, prNumber, repoId, prHeadSha } = localPRThreads
  return useMemo(() => {
    if (!active || !worktreeId || prNumber === null || !repoId || comments.length === 0) {
      return EMPTY_THREADS
    }
    const anchored = anchorLocalThreadsForFile({
      comments,
      path: relativePath,
      repoId,
      prNumber,
      worktreeId,
      context: {
        modifiedContent,
        headMatchesPrHead: !!prHeadSha && localHeadOid === prHeadSha
      }
    })
    return {
      inline: [
        ...(enrichInlineCommentsWithSuggestionTargets(anchored.inline, {
          path: relativePath,
          modifiedContent
        }) ?? anchored.inline)
      ],
      outdated: anchored.outdated
    }
  }, [
    active,
    comments,
    localHeadOid,
    modifiedContent,
    prHeadSha,
    prNumber,
    relativePath,
    repoId,
    worktreeId
  ])
}
