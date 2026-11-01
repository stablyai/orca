import {
  useDiffCommentView,
  useOwnedDiffCommentTarget
} from '../diff-comments/use-diff-comment-owner'
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
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
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

  const { owner: commentOwner, comments: allDiffComments } = useDiffCommentView(worktreeId)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)

  const markdownComments = useMemo(
    () =>
      (allDiffComments ?? []).filter((c) => c.filePath === relativePath && isMarkdownComment(c)),
    [allDiffComments, relativePath]
  )

  const [commentPopover, setCommentPopover, commentPopoverOwnerRef] =
    useOwnedDiffCommentTarget<MarkdownCommentPopoverState>(worktreeId)
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
    commentOwner,
    editor: shouldShowMarkdownAnnotations ? mountedEditor : null,
    filePath: relativePath,
    worktreeId: worktreeId ?? '',
    comments: shouldShowMarkdownAnnotations ? markdownComments : [],
    pendingCommentTarget: commentPopover,
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
        void (commentOwner && deleteDiffComment(commentOwner, id))
      }
    },
    onUpdateComment: worktreeId
      ? (id, body) =>
          commentOwner ? updateDiffComment(commentOwner, id, body) : Promise.resolve(false)
      : undefined,
    formatCommentPrompt: formatMarkdownCommentPrompt,
    pendingScrollCommentId: pendingScrollForThisEditor,
    onPendingScrollConsumed: () => setScrollToDiffCommentId(null)
  })

  // Why the line number alone: match DiffViewer, so popover top updates don't resubscribe.
  const popoverLineNumber = commentPopover?.lineNumber
  useEffect(() => {
    if (!mountedEditor || popoverLineNumber === undefined) {
      return
    }
    const update = (): void => {
      const top = getDiffCommentPopoverTop(mountedEditor, popoverLineNumber, undefined)
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
  }, [mountedEditor, popoverLineNumber, editorContainerRef, setCommentPopover])

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
    const owner = commentPopoverOwnerRef.current
    const result = await (owner
      ? addDiffComment(owner, {
          worktreeId,
          filePath: relativePath,
          source: 'markdown',
          startLine: commentPopover.startLine,
          lineNumber: commentPopover.lineNumber,
          selectedText: commentPopover.selectedText,
          body,
          side: 'modified'
        })
      : null)
    if (result) {
      setCommentPopover(null)
    } else {
      // The draft stays open for retry.
      toast.error(
        translate('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment')
      )
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
