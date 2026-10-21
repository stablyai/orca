import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectWorktreeDiffCommentsOrEmpty } from '@/store/worktree-diff-comments-selector'
import {
  isMarkdownReviewNotesEnabled,
  withoutMarkdownReviewNotes
} from '@/lib/markdown-review-notes-setting'
import type { DiffComment } from '../../../../shared/diff-comment-types'

/** Worktree notes the user can see: markdown notes drop out while the Markdown Review Notes setting is off. */
export function useVisibleWorktreeDiffComments(worktreeId: string | null | undefined): {
  comments: DiffComment[]
  markdownReviewNotesEnabled: boolean
} {
  // Why: pass worktreeId even when null so the selector returns its stable empty sentinel; an inline [] would break Zustand's Object.is and churn.
  const allComments = useAppStore((s) => selectWorktreeDiffCommentsOrEmpty(s, worktreeId))
  const markdownReviewNotesEnabled = useAppStore((s) => isMarkdownReviewNotesEnabled(s.settings))
  const comments = useMemo(
    () => (markdownReviewNotesEnabled ? allComments : withoutMarkdownReviewNotes(allComments)),
    [allComments, markdownReviewNotesEnabled]
  )
  return { comments, markdownReviewNotesEnabled }
}
