import { useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  formatMarkdownReviewNotes,
  sortMarkdownReviewNotes,
  type MarkdownReviewNote
} from '@/lib/markdown-review-notes'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { createMarkdownDocumentIndex } from './markdown-doc-links'
import { extractFrontMatter } from './markdown-frontmatter'
import { previewHasAnnotationBlockKey } from './markdown-preview-annotation-shortcut'
import { selectMarkdownTableOfContents } from './markdown-toc-visibility-gate'
import type { NotesSendMenuScope } from './NotesSendMenu'
import { useMarkdownPreviewSourceFoundation } from './use-markdown-preview-source-foundation'

export function useMarkdownPreviewFoundation({
  content,
  filePath,
  sourceFileId,
  sourceWorktreeId,
  sourceRuntimeEnvironmentId,
  showTableOfContents,
  markdownDocuments,
  markdownAnnotationsEnabled
}: {
  content: string
  filePath: string
  sourceFileId: string | null
  sourceWorktreeId: string | null
  sourceRuntimeEnvironmentId: string | null | undefined
  showTableOfContents: boolean
  markdownDocuments: MarkdownDocument[]
  markdownAnnotationsEnabled: boolean
}) {
  const source = useMarkdownPreviewSourceFoundation({
    content,
    filePath,
    sourceFileId,
    sourceWorktreeId,
    sourceRuntimeEnvironmentId
  })
  const {
    rootRef,
    renderedContent,
    frontmatterVisibleByFile,
    sourceWorktree,
    sourceRelativePath,
    markdownComments
  } = source

  const frontMatter = useMemo(() => extractFrontMatter(renderedContent), [renderedContent])
  const tableOfContentsItems = useMemo(
    () => selectMarkdownTableOfContents(showTableOfContents, renderedContent),
    [renderedContent, showTableOfContents]
  )
  const markdownDocumentIndex = useMemo(
    () => createMarkdownDocumentIndex(markdownDocuments),
    [markdownDocuments]
  )
  const frontMatterInner = useMemo(() => {
    if (!frontMatter) {
      return ''
    }
    return frontMatter.raw
      .replace(/^(?:---|\+\+\+)\r?\n/, '')
      .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
      .trim()
  }, [frontMatter])
  const toggleableSourceFileId: string | null = sourceFileId ?? null
  const frontmatterVisible = toggleableSourceFileId
    ? (frontmatterVisibleByFile[toggleableSourceFileId] ?? true)
    : true
  const [activeAnnotationBlockKey, setActiveAnnotationBlockKey] = useState<string | null>(null)
  const activeAnnotationBlockKeyRef = useRef(activeAnnotationBlockKey)
  useEffect(() => {
    activeAnnotationBlockKeyRef.current = activeAnnotationBlockKey
  }, [activeAnnotationBlockKey])
  useEffect(() => {
    if (!activeAnnotationBlockKey) {
      return
    }
    const root = rootRef.current
    if (!root || previewHasAnnotationBlockKey(root, activeAnnotationBlockKey)) {
      return
    }
    setActiveAnnotationBlockKey(null)
  }, [activeAnnotationBlockKey, renderedContent, rootRef])
  const [reviewNotesCopied, setReviewNotesCopied] = useState(false)
  const [copiedReviewNoteId, setCopiedReviewNoteId] = useState<string | null>(null)
  const reviewNotesCopiedResetTimerRef = useRef<number | null>(null)
  const copiedReviewNoteResetTimerRef = useRef<number | null>(null)
  const reviewNotesCopyMountedRef = useRef(false)
  const [activeReviewCommentId, setActiveReviewCommentId] = useState<string | null>(null)
  const [attentionReviewCommentId, setAttentionReviewCommentId] = useState<string | null>(null)
  const attentionReviewCommentTimeoutRef = useRef<number | null>(null)
  const markdownReviewNotes = useMemo(
    () => sortMarkdownReviewNotes(markdownComments as MarkdownReviewNote[]),
    [markdownComments]
  )
  const unsentMarkdownReviewNotes = useMemo(
    () => markdownReviewNotes.filter((note) => !note.sentAt),
    [markdownReviewNotes]
  )
  const unsentMarkdownReviewPrompt = useMemo(
    () => formatMarkdownReviewNotes(unsentMarkdownReviewNotes, renderedContent),
    [renderedContent, unsentMarkdownReviewNotes]
  )
  const unsentMarkdownReviewScope = useMemo<NotesSendMenuScope<MarkdownReviewNote>[]>(
    () => [
      {
        id: 'all',
        label: translate('auto.components.editor.MarkdownPreview.ddf087d12e', 'All unsent notes'),
        notes: unsentMarkdownReviewNotes,
        prompt: unsentMarkdownReviewPrompt
      }
    ],
    [unsentMarkdownReviewNotes, unsentMarkdownReviewPrompt]
  )
  const canShowReviewTools = Boolean(
    markdownAnnotationsEnabled && sourceWorktree && sourceRelativePath !== null
  )

  return {
    ...source,
    frontMatter,
    tableOfContentsItems,
    markdownDocumentIndex,
    frontMatterInner,
    frontmatterVisible,
    activeAnnotationBlockKey,
    setActiveAnnotationBlockKey,
    activeAnnotationBlockKeyRef,
    reviewNotesCopied,
    setReviewNotesCopied,
    copiedReviewNoteId,
    setCopiedReviewNoteId,
    reviewNotesCopiedResetTimerRef,
    copiedReviewNoteResetTimerRef,
    reviewNotesCopyMountedRef,
    activeReviewCommentId,
    setActiveReviewCommentId,
    attentionReviewCommentId,
    setAttentionReviewCommentId,
    attentionReviewCommentTimeoutRef,
    markdownReviewNotes,
    unsentMarkdownReviewScope,
    canShowReviewTools
  }
}

export type MarkdownPreviewFoundation = ReturnType<typeof useMarkdownPreviewFoundation>
