import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { editor } from 'monaco-editor'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { useAppStore } from '@/store'
import { selectWorktreeDiffComments } from '@/store/worktree-diff-comments-selector'
import { isMarkdownComment } from '@/lib/diff-comment-compat'
import { formatMarkdownReviewNotes, type MarkdownReviewNote } from '@/lib/markdown-review-notes'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import {
  getDiffCommentPopoverLeft,
  getDiffCommentPopoverTop
} from '../diff-comments/diff-comment-popover-position'
import {
  getMonacoMarkdownSelectionAnnotationTarget,
  type MonacoMarkdownSelectionAnnotationTarget
} from './monaco-markdown-selection-annotation'

export type MarkdownCommentPopoverState = Omit<
  MonacoMarkdownSelectionAnnotationTarget,
  'selectedText'
> & {
  selectedText?: string
}

export type MonacoMarkdownAnnotations = {
  shouldShowMarkdownAnnotations: boolean
  shouldShowMarkdownAnnotationsRef: MutableRefObject<boolean>
  commentPopover: MarkdownCommentPopoverState | null
  setCommentPopover: Dispatch<SetStateAction<MarkdownCommentPopoverState | null>>
  commentPopoverRef: MutableRefObject<MarkdownCommentPopoverState | null>
  selectionAnnotationTarget: MonacoMarkdownSelectionAnnotationTarget | null
  setSelectionAnnotationTarget: Dispatch<
    SetStateAction<MonacoMarkdownSelectionAnnotationTarget | null>
  >
  handleSubmitMarkdownComment: (body: string) => Promise<void>
}

export function useMonacoMarkdownAnnotations(params: {
  mountedEditor: editor.IStandaloneCodeEditor | null
  editorContainerRef: MutableRefObject<HTMLDivElement | null>
  relativePath: string
  content: string
  language: string
  worktreeId: string | undefined
  markdownAnnotationsEnabled: boolean
}): MonacoMarkdownAnnotations {
  const {
    mountedEditor,
    editorContainerRef,
    relativePath,
    content,
    language,
    worktreeId,
    markdownAnnotationsEnabled
  } = params

  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    selectWorktreeDiffComments(s, worktreeId)
  )

  const markdownComments = useMemo(
    () =>
      (allDiffComments ?? []).filter((c) => c.filePath === relativePath && isMarkdownComment(c)),
    [allDiffComments, relativePath]
  )

  const [commentPopover, setCommentPopover] = useState<MarkdownCommentPopoverState | null>(null)
  const [selectionAnnotationTarget, setSelectionAnnotationTarget] =
    useState<MonacoMarkdownSelectionAnnotationTarget | null>(null)
  // Why: claim drafts synchronously so a same-tick second chord can't remount the composer before React commits state.
  const commentPopoverRef = useRef<MarkdownCommentPopoverState | null>(null)
  useEffect(() => {
    commentPopoverRef.current = commentPopover
  }, [commentPopover])

  const shouldShowMarkdownAnnotations =
    markdownAnnotationsEnabled && language === 'markdown' && Boolean(worktreeId)
  // Why: the mount closure installs keydown listeners once, so the shortcut reads current enablement through a ref.
  const shouldShowMarkdownAnnotationsRef = useRef(shouldShowMarkdownAnnotations)
  useEffect(() => {
    shouldShowMarkdownAnnotationsRef.current = shouldShowMarkdownAnnotations
  }, [shouldShowMarkdownAnnotations])

  const pendingScrollForThisEditor = useMemo(() => {
    if (!shouldShowMarkdownAnnotations || !scrollToDiffCommentId) {
      return null
    }
    return markdownComments.some((c) => c.id === scrollToDiffCommentId)
      ? scrollToDiffCommentId
      : null
  }, [markdownComments, scrollToDiffCommentId, shouldShowMarkdownAnnotations])
  const formatMarkdownCommentPrompt = useCallback(
    (comment: DiffComment) => formatMarkdownReviewNotes([comment as MarkdownReviewNote], content),
    [content]
  )

  useDiffCommentDecorator({
    editor: shouldShowMarkdownAnnotations ? mountedEditor : null,
    filePath: relativePath,
    worktreeId: worktreeId ?? '',
    comments: shouldShowMarkdownAnnotations ? markdownComments : [],
    onAddCommentClick: ({ lineNumber, startLine, top }) => {
      setSelectionAnnotationTarget(null)
      setCommentPopover({
        lineNumber,
        startLine,
        top,
        left: mountedEditor
          ? (getDiffCommentPopoverLeft(mountedEditor, editorContainerRef.current) ?? undefined)
          : undefined
      })
    },
    onDeleteComment: (id) => {
      if (worktreeId) {
        void deleteDiffComment(worktreeId, id)
      }
    },
    onUpdateComment: worktreeId ? (id, body) => updateDiffComment(worktreeId, id, body) : undefined,
    formatCommentPrompt: formatMarkdownCommentPrompt,
    pendingScrollCommentId: pendingScrollForThisEditor,
    onPendingScrollConsumed: () => setScrollToDiffCommentId(null)
  })

  useEffect(() => {
    if (!mountedEditor || !commentPopover) {
      return
    }
    const update = (): void => {
      const top = getDiffCommentPopoverTop(mountedEditor, commentPopover.lineNumber, undefined)
      const left = getDiffCommentPopoverLeft(mountedEditor, editorContainerRef.current)
      setCommentPopover((prev) =>
        prev ? { ...prev, top: top ?? prev.top, left: left == null ? prev.left : left } : prev
      )
    }
    const scrollSub = mountedEditor.onDidScrollChange(update)
    const contentSub = mountedEditor.onDidContentSizeChange(update)
    const layoutSub = mountedEditor.onDidLayoutChange(update)
    return () => {
      scrollSub.dispose()
      contentSub.dispose()
      layoutSub.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- match DiffViewer: don't resubscribe on top updates.
  }, [mountedEditor, commentPopover?.lineNumber])

  useEffect(() => {
    if (!mountedEditor || !shouldShowMarkdownAnnotations || commentPopover) {
      setSelectionAnnotationTarget(null)
      return
    }
    const update = (): void => {
      const left = getDiffCommentPopoverLeft(mountedEditor, editorContainerRef.current)
      setSelectionAnnotationTarget(
        getMonacoMarkdownSelectionAnnotationTarget(
          mountedEditor,
          mountedEditor.getSelection(),
          left ?? undefined
        )
      )
    }
    update()
    const selectionSub = mountedEditor.onDidChangeCursorSelection(update)
    const scrollSub = mountedEditor.onDidScrollChange(update)
    const layoutSub = mountedEditor.onDidLayoutChange(update)
    return () => {
      selectionSub.dispose()
      scrollSub.dispose()
      layoutSub.dispose()
    }
  }, [commentPopover, editorContainerRef, mountedEditor, shouldShowMarkdownAnnotations])

  const handleSubmitMarkdownComment = async (body: string): Promise<void> => {
    if (!commentPopover || !worktreeId) {
      return
    }
    const result = await addDiffComment({
      worktreeId,
      filePath: relativePath,
      source: 'markdown',
      startLine: commentPopover.startLine,
      lineNumber: commentPopover.lineNumber,
      selectedText: commentPopover.selectedText,
      body,
      side: 'modified'
    })
    if (result) {
      setCommentPopover(null)
    } else {
      console.error('Failed to add markdown comment — draft preserved')
    }
  }

  return {
    shouldShowMarkdownAnnotations,
    shouldShowMarkdownAnnotationsRef,
    commentPopover,
    setCommentPopover,
    commentPopoverRef,
    selectionAnnotationTarget,
    setSelectionAnnotationTarget,
    handleSubmitMarkdownComment
  }
}
