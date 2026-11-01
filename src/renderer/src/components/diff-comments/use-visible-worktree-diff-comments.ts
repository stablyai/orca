import { useDiffCommentView } from './use-diff-comment-owner'
import type { DiffCommentOwner } from '@/store/diff-comment-owner'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  isMarkdownReviewNotesEnabled,
  withoutMarkdownReviewNotes
} from '@/lib/markdown-review-notes-setting'
import type { DiffComment } from '../../../../shared/diff-comment-types'

const NO_COMMENTS: DiffComment[] = []

export function useVisibleWorktreeDiffComments(worktreeId: string | null | undefined): {
  owner: DiffCommentOwner | null
  comments: DiffComment[]
  markdownReviewNotesEnabled: boolean
} {
  const { owner, comments: listed } = useDiffCommentView(worktreeId)
  // Unlisted workspaces still need a stable empty list; inline arrays would churn memoized consumers.
  const allComments = listed ?? NO_COMMENTS
  const markdownReviewNotesEnabled = useAppStore((s) => isMarkdownReviewNotesEnabled(s.settings))
  const comments = useMemo(
    () => (markdownReviewNotesEnabled ? allComments : withoutMarkdownReviewNotes(allComments)),
    [allComments, markdownReviewNotesEnabled]
  )
  return { owner, comments, markdownReviewNotesEnabled }
}
