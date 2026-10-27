import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectWorktreeDiffCommentsOrEmpty } from '@/store/worktree-diff-comments-selector'
import {
  isMarkdownReviewNotesEnabled,
  withoutMarkdownReviewNotes
} from '@/lib/markdown-review-notes-setting'
import type { DiffComment } from '../../../../shared/diff-comment-types'

export function useVisibleWorktreeDiffComments(worktreeId: string | null | undefined): {
  comments: DiffComment[]
  markdownReviewNotesEnabled: boolean
} {
  // Null owners still need the selector’s stable empty sentinel; inline arrays would churn Zustand subscribers.
  const allComments = useAppStore((s) => selectWorktreeDiffCommentsOrEmpty(s, worktreeId))
  const markdownReviewNotesEnabled = useAppStore((s) => isMarkdownReviewNotesEnabled(s.settings))
  const comments = useMemo(
    () => (markdownReviewNotesEnabled ? allComments : withoutMarkdownReviewNotes(allComments)),
    [allComments, markdownReviewNotesEnabled]
  )
  return { comments, markdownReviewNotesEnabled }
}
