import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { DiffComment, MarkdownDocument } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { useLocalImagePick } from './useLocalImagePick'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import { useLinkBubble } from './useLinkBubble'
import { useEditorScrollRestore } from './useEditorScrollRestore'
import { useModifierHeldClass } from './useModifierHeldClass'
import { registerPendingEditorFlush } from './editor-pending-flush'
import type { MarkdownTocItem } from './markdown-table-of-contents'
import { selectMarkdownTableOfContents } from './markdown-toc-visibility-gate'
import { RichMarkdownEditorSurface } from './RichMarkdownEditorSurface'
import { useRichMarkdownEditorInstance } from './useRichMarkdownEditorInstance'
import { useRichMarkdownMenuController } from './useRichMarkdownMenuController'
import { useRichMarkdownProgrammaticSync } from './useRichMarkdownProgrammaticSync'
import { useRichMarkdownReviewController } from './useRichMarkdownReviewController'
import { useRichMarkdownReviewEditorEffects } from './useRichMarkdownReviewEditorEffects'
import {
  isRichMarkdownContextCommandTarget,
  runRichMarkdownContextCommand
} from './rich-markdown-context-command-routing'

type RichMarkdownEditorProps = {
  fileId: string
  content: string
  filePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
  scrollCacheKey: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => void
  onOpenDocLink?: (target: string) => void
  markdownDocuments?: MarkdownDocument[]
  showTableOfContents?: boolean
  onCloseTableOfContents?: () => void
  markdownAnnotationsEnabled?: boolean
  markdownAnnotationFilePath?: string
  markdownSourceLineOffset?: number
  markdownReviewContent?: string
  // Why: front-matter is stripped from the rich editor's content but we still
  // want it visible to the user. It renders between the toolbar and the editor
  // surface so the formatting toolbar stays at the top of the pane.
  headerSlot?: React.ReactNode
}

function flattenMarkdownTocItems(items: MarkdownTocItem[]): MarkdownTocItem[] {
  return items.flatMap((item) => [item, ...flattenMarkdownTocItems(item.children)])
}

export default function RichMarkdownEditor({
  fileId,
  content,
  filePath,
  worktreeId,
  runtimeEnvironmentId,
  scrollCacheKey,
  onContentChange,
  onDirtyStateHint,
  onSave,
  onOpenDocLink,
  markdownDocuments,
  showTableOfContents = false,
  onCloseTableOfContents,
  markdownAnnotationsEnabled = false,
  markdownAnnotationFilePath,
  markdownSourceLineOffset = 0,
  markdownReviewContent = content,
  headerSlot
}: RichMarkdownEditorProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const activateMarkdownLink = useAppStore((s) => s.activateMarkdownLink)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const allDiffComments = useAppStore((s): DiffComment[] | undefined => {
    for (const list of Object.values(s.worktreesByRepo)) {
      const worktree = list.find((candidate) => candidate.id === worktreeId)
      if (worktree) {
        return worktree.diffComments
      }
    }
    return undefined
  })
  const worktreeRoot = useAppStore((s) => {
    for (const list of Object.values(s.worktreesByRepo)) {
      const wt = list.find((w) => w.id === worktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  })
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const menu = useRichMarkdownMenuController({ markdownDocuments })
  const isMac = navigator.userAgent.includes('Mac')
  const lastCommittedMarkdownRef = useRef(content)
  const onContentChangeRef = useRef(onContentChange)
  const onDirtyStateHintRef = useRef(onDirtyStateHint)
  const onSaveRef = useRef(onSave)
  const onOpenDocLinkRef = useRef(onOpenDocLink)
  const handleLocalImagePickRef = useRef<() => void>(() => {})
  const openSearchRef = useRef<() => void>(() => {})
  // Why: ProseMirror keeps the initial handleKeyDown closure, so `editor` stays
  // stuck at the first-render null value unless we read the live instance here.
  const editorRef = useRef<Editor | null>(null)
  const cancelAutoFocusRef = useRef<(() => void) | null>(null)
  const serializeTimerRef = useRef<number | null>(null)
  // Why: normalizeSoftBreaks dispatches a ProseMirror transaction inside onCreate
  // which triggers onUpdate. Without this guard the editor immediately marks the
  // file dirty before the user has typed anything.
  const isInitializingRef = useRef(true)
  // Why: internal maintenance paths can dispatch transactions after mount
  // (external reloads, soft-break normalization, image-path refresh). Those
  // are not user edits, so onUpdate must ignore them or split panes can flip a
  // shared file dirty without any real content change.
  const isApplyingProgrammaticUpdateRef = useRef(false)
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null)
  const [isEditingLink, setIsEditingLink] = useState(false)
  const isEditingLinkRef = useRef(false)
  const typedEmptyOrderedListMarkerRef = useRef(false)
  const review = useRichMarkdownReviewController({
    addDiffComment,
    allDiffComments,
    content,
    editorRef,
    filePath,
    markdownAnnotationFilePath,
    markdownAnnotationsEnabled,
    markdownReviewContent,
    markdownSourceLineOffset,
    rootRef,
    scrollContainerRef,
    worktreeId,
    worktreeRoot
  })
  // Why: building the table of contents runs a full-document remark parse on
  // every content change. The result is only used while the panel is open
  // (closed by default), so gate the parse on visibility; including
  // showTableOfContents in deps rebuilds the outline the moment it opens.
  const tableOfContentsItems = useMemo(
    () => selectMarkdownTableOfContents(showTableOfContents, content),
    [content, showTableOfContents]
  )
  const flatTableOfContentsItems = useMemo(
    () => flattenMarkdownTocItems(tableOfContentsItems),
    [tableOfContentsItems]
  )

  // Why: assigning callback refs during render keeps them current before any
  // ProseMirror handler reads them, avoiding the one-render stale window that
  // useEffect would introduce. Refs are mutable and never trigger re-renders.
  onContentChangeRef.current = onContentChange
  onDirtyStateHintRef.current = onDirtyStateHint
  onSaveRef.current = onSave
  onOpenDocLinkRef.current = onOpenDocLink
  isEditingLinkRef.current = isEditingLink

  const flushPendingSerialization = useCallback(() => {
    if (serializeTimerRef.current === null) {
      return
    }
    window.clearTimeout(serializeTimerRef.current)
    serializeTimerRef.current = null
    try {
      const markdown = editorRef.current?.getMarkdown()
      if (markdown !== undefined) {
        lastCommittedMarkdownRef.current = markdown
        onContentChangeRef.current(markdown)
      }
    } catch {
      // Why: save/restart flows should never crash the UI just because the
      // editor was torn down between scheduling and flushing a debounced sync.
    }
  }, [])

  useEffect(() => {
    // Why: autosave/restart paths live outside the editor component tree, so a
    // mounted rich editor must expose a synchronous "flush now" hook to avoid
    // a dirty-without-draft window during the debounce period.
    return registerPendingEditorFlush(fileId, flushPendingSerialization)
  }, [fileId, flushPendingSerialization])

  const { clearTransientReviewState } = review
  const setRootElement = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        // Why: these transient editor resources are owned by this root; clearing
        // them at detach keeps unmount cleanup out of passive Effects.
        clearTransientReviewState()
        cancelAutoFocusRef.current?.()
        cancelAutoFocusRef.current = null
        window.api.ui.setMarkdownEditorFocused(false)
      }
      rootRef.current = node
    },
    [clearTransientReviewState]
  )

  const editor = useRichMarkdownEditorInstance({
    content,
    filePath,
    worktreeId,
    worktreeRoot,
    runtimeEnvironmentId,
    isMac,
    settings,
    activateMarkdownLink,
    rootRef,
    editorRef,
    lastCommittedMarkdownRef,
    onContentChangeRef,
    onDirtyStateHintRef,
    onSaveRef,
    onOpenDocLinkRef,
    isEditingLinkRef,
    slashMenuRef: menu.slashMenuRef,
    filteredSlashCommandsRef: menu.filteredSlashCommandsRef,
    selectedCommandIndexRef: menu.selectedCommandIndexRef,
    docLinkMenuRef: menu.docLinkMenuRef,
    filteredDocLinkRowsRef: menu.filteredDocLinkRowsRef,
    selectedDocLinkIndexRef: menu.selectedDocLinkIndexRef,
    handleLocalImagePickRef,
    handleEmojiPickRef: menu.handleEmojiPickRef,
    typedEmptyOrderedListMarkerRef,
    cancelAutoFocusRef,
    serializeTimerRef,
    isInitializingRef,
    isApplyingProgrammaticUpdateRef,
    markdownCommentsRef: review.markdownCommentsRef,
    markdownSourceLineOffsetRef: review.markdownSourceLineOffsetRef,
    flushPendingSerialization,
    openSearchRef,
    syncAnnotationTarget: review.syncAnnotationTarget,
    clearAnnotationTarget: review.clearAnnotationTarget,
    scrollRichMarkdownReviewNoteCardIntoView: review.scrollRichMarkdownReviewNoteCardIntoView,
    setIsEditingLink,
    setLinkBubble,
    setSelectedCommandIndex: menu.setSelectedCommandIndex,
    setSelectedDocLinkIndex: menu.setSelectedDocLinkIndex,
    setSlashMenu: menu.setSlashMenu,
    setDocLinkMenu: menu.setDocLinkMenu
  })

  // Why: use useLayoutEffect (synchronous cleanup) so the pending serialization
  // flush runs before useEditor's cleanup destroys the editor instance on tab
  // switch or mode change. React runs layout-effect cleanups before effect
  // cleanups, guaranteeing the editor is still alive when we serialize.
  React.useLayoutEffect(() => {
    return flushPendingSerialization
  }, [flushPendingSerialization])

  useEditorScrollRestore(scrollContainerRef, scrollCacheKey, editor)

  useModifierHeldClass(rootRef, isMac)

  useRichMarkdownReviewEditorEffects({
    canAnnotateRichMarkdown: review.canAnnotateRichMarkdown,
    content,
    editor,
    markdownComments: review.markdownComments,
    markdownSourceLineOffset,
    scrollContainerRef,
    syncAnnotationTarget: review.syncAnnotationTarget
  })

  useRichMarkdownProgrammaticSync({
    content,
    docLinkMenuSetter: menu.setDocLinkMenu,
    editor,
    fileId,
    filePath,
    isApplyingProgrammaticUpdateRef,
    lastCommittedMarkdownRef,
    markdownDocuments,
    rootRef,
    runtimeEnvironmentId,
    settings,
    slashMenuSetter: menu.setSlashMenu,
    worktreeId,
    worktreeRoot
  })

  const handleLocalImagePick = useLocalImagePick(editor, filePath, worktreeId, runtimeEnvironmentId)
  handleLocalImagePickRef.current = handleLocalImagePick

  const {
    handleLinkSave,
    handleLinkRemove,
    handleLinkEditCancel,
    handleLinkOpen,
    toggleLinkFromToolbar
  } = useLinkBubble(editor, rootRef, linkBubble, setLinkBubble, setIsEditingLink, {
    sourceFilePath: filePath,
    worktreeId,
    worktreeRoot,
    runtimeEnvironmentId
  })

  useEffect(() => {
    return window.api.ui.onRichMarkdownContextCommand((payload) => {
      const ed = editorRef.current
      if (!ed || !isRichMarkdownContextCommandTarget(payload, rootRef.current)) {
        return
      }

      runRichMarkdownContextCommand({
        command: payload.command,
        editor: ed,
        toggleLink: toggleLinkFromToolbar,
        pickImage: handleLocalImagePick
      })
    })
  }, [handleLocalImagePick, toggleLinkFromToolbar])

  const { openSearch, searchState, searchActions } = useRichMarkdownSearch({
    editor,
    rootRef,
    scrollContainerRef
  })
  openSearchRef.current = openSearch

  const navigateToTableOfContentsItem = useCallback(
    (id: string): void => {
      const target = flatTableOfContentsItems.find((item) => item.id === id)
      const container = scrollContainerRef.current
      if (!target || !container) {
        return
      }
      const sameTitleIndex = flatTableOfContentsItems
        .filter((item) => item.title === target.title)
        .findIndex((item) => item.id === target.id)
      const matchingHeadings = Array.from(
        container.querySelectorAll<HTMLElement>('h1, h2, h3')
      ).filter((candidate) => candidate.textContent?.trim() === target.title)
      const heading = matchingHeadings.at(Math.max(0, sameTitleIndex))
      heading?.scrollIntoView({ block: 'center' })
    },
    [flatTableOfContentsItems]
  )

  return (
    <RichMarkdownEditorSurface
      editor={editor}
      editorFontZoomLevel={editorFontZoomLevel}
      rootRef={setRootElement}
      scrollContainerRef={scrollContainerRef}
      headerSlot={headerSlot}
      reviewRailExpanded={review.reviewRailExpanded}
      reviewRailVisible={review.reviewRailVisible}
      notePositions={review.notePositions}
      activeReviewCommentId={review.activeReviewCommentId}
      attentionReviewCommentId={review.attentionReviewCommentId}
      copiedReviewNoteId={review.copiedReviewNoteId}
      markdownReviewContent={markdownReviewContent}
      worktreeId={worktreeId}
      filePath={filePath}
      markdownCommentsCount={review.markdownComments.length}
      reviewRailOpen={review.reviewRailOpen}
      reviewNotesCopied={review.reviewNotesCopied}
      unsentMarkdownReviewScope={review.unsentMarkdownReviewScope}
      linkBubble={linkBubble}
      isEditingLink={isEditingLink}
      slashMenu={menu.slashMenu}
      filteredSlashCommands={menu.filteredSlashCommands}
      selectedCommandIndex={menu.selectedCommandIndex}
      emojiMenu={menu.emojiMenu}
      docLinkMenu={menu.docLinkMenu}
      docLinkRows={menu.docLinkRows}
      docLinkTotalMatches={menu.docLinkTotalMatches}
      selectedDocLinkIndex={menu.selectedDocLinkIndex}
      annotationTarget={review.annotationTarget}
      annotationPopover={review.annotationPopover}
      markdownSourceLineOffset={markdownSourceLineOffset}
      tableOfContentsItems={tableOfContentsItems}
      showTableOfContents={showTableOfContents}
      searchState={searchState}
      searchActions={searchActions}
      linkBubbleActions={{
        handleLinkSave,
        handleLinkRemove,
        handleLinkEditCancel,
        handleLinkOpen,
        setIsEditingLink
      }}
      onToggleLink={toggleLinkFromToolbar}
      onImagePick={handleLocalImagePick}
      onEmojiPick={menu.openEmojiMenu}
      onCloseEmojiMenu={() => menu.setEmojiMenu(null)}
      onOpenAnnotationPopover={review.openAnnotationPopover}
      onCancelAnnotationPopover={() => {
        review.setAnnotationPopover(null)
        review.clearAnnotationHighlight()
      }}
      onSubmitAnnotation={review.submitAnnotation}
      onCopyReviewNotes={() => void review.handleCopyMarkdownReviewNotes()}
      onCopyReviewNote={(note) => void review.handleCopyMarkdownReviewNote(note)}
      onToggleReviewRail={() => review.setReviewRailOpen((open) => !open)}
      onReviewNotesDelivered={(notes) => void clearDeliveredDiffComments(worktreeId, notes)}
      onReviewNoteSourceClick={review.scrollRichMarkdownReviewNoteSourceIntoView}
      onDeleteReviewComment={(commentId) => void deleteDiffComment(worktreeId, commentId)}
      onSubmitReviewCommentEdit={(commentId, body) =>
        updateDiffComment(worktreeId, commentId, body)
      }
      onReviewNoteContentResize={review.syncNotePositions}
      onNavigateTableOfContentsItem={navigateToTableOfContentsItem}
      onCloseTableOfContents={onCloseTableOfContents}
    />
  )
}
