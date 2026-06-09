import { useMemo } from 'react'
import { getRelativePathInsideRoot, normalizeRelativePath } from '@/lib/path'
import { isMarkdownComment } from '@/lib/diff-comment-compat'
import {
  formatMarkdownReviewNotes,
  sortMarkdownReviewNotes,
  type MarkdownReviewNote
} from '@/lib/markdown-review-notes'
import type { NotesSendMenuScope } from './NotesSendMenu'
import type { DiffComment } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

type UseRichMarkdownReviewDataOptions = {
  allDiffComments: DiffComment[] | undefined
  filePath: string
  markdownAnnotationFilePath?: string
  markdownAnnotationsEnabled: boolean
  markdownReviewContent: string
  worktreeRoot: string | null
}

export function useRichMarkdownReviewData({
  allDiffComments,
  filePath,
  markdownAnnotationFilePath,
  markdownAnnotationsEnabled,
  markdownReviewContent,
  worktreeRoot
}: UseRichMarkdownReviewDataOptions): {
  canAnnotateRichMarkdown: boolean
  markdownComments: DiffComment[]
  markdownReviewNotes: MarkdownReviewNote[]
  sourceRelativePath: string | null
  unsentMarkdownReviewScope: NotesSendMenuScope<MarkdownReviewNote>[]
} {
  const sourceRelativePath = useMemo(
    () =>
      markdownAnnotationFilePath
        ? normalizeRelativePath(markdownAnnotationFilePath)
        : getRelativePathInsideRoot(filePath, worktreeRoot),
    [filePath, markdownAnnotationFilePath, worktreeRoot]
  )
  const canAnnotateRichMarkdown = Boolean(markdownAnnotationsEnabled && sourceRelativePath !== null)
  const markdownComments = useMemo(
    () =>
      (allDiffComments ?? []).filter(
        (comment) => comment.filePath === sourceRelativePath && isMarkdownComment(comment)
      ),
    [allDiffComments, sourceRelativePath]
  )
  const markdownReviewNotes = useMemo(
    () => sortMarkdownReviewNotes(markdownComments as MarkdownReviewNote[]),
    [markdownComments]
  )
  const unsentMarkdownReviewScope = useMemo<NotesSendMenuScope<MarkdownReviewNote>[]>(() => {
    const unsentNotes = markdownReviewNotes.filter((note) => !note.sentAt)
    return [
      {
        id: 'all',
        label: translate("auto.components.editor.useRichMarkdownReviewData.f9d2acd6b0", "All unsent notes"),
        notes: unsentNotes,
        prompt: formatMarkdownReviewNotes(unsentNotes, markdownReviewContent)
      }
    ]
  }, [markdownReviewContent, markdownReviewNotes])

  return {
    canAnnotateRichMarkdown,
    markdownComments,
    markdownReviewNotes,
    sourceRelativePath,
    unsentMarkdownReviewScope
  }
}
