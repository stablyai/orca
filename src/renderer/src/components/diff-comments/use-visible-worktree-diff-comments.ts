import { useDiffCommentOwner } from './use-diff-comment-owner'
import type { DiffCommentOwner } from '@/store/worktree-diff-comments-selector'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectWorktreeDiffCommentsOrEmpty } from '@/store/worktree-diff-comments-selector'
import {
  isMarkdownReviewNotesEnabled,
  withoutMarkdownReviewNotes
} from '@/lib/markdown-review-notes-setting'
import type { DiffComment } from '../../../../shared/diff-comment-types'

export function useVisibleWorktreeDiffComments(worktreeId: string | null | undefined): {
  owner: DiffCommentOwner | null
  comments: DiffComment[]
  markdownReviewNotesEnabled: boolean
} {
  const owner = useDiffCommentOwner(worktreeId)
  // Null owners still need the selector’s stable empty sentinel; inline arrays would churn Zustand subscribers.
  const allComments = useAppStore((s) => selectWorktreeDiffCommentsOrEmpty(s, worktreeId))
  const markdownReviewNotesEnabled = useAppStore((s) => isMarkdownReviewNotesEnabled(s.settings))
  const comments = useMemo(
    () => (markdownReviewNotesEnabled ? allComments : withoutMarkdownReviewNotes(allComments)),
    [allComments, markdownReviewNotesEnabled]
  )
  return { owner, comments, markdownReviewNotesEnabled }
}
