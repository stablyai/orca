/* eslint-disable max-lines -- Why: centralizes Monaco setup, markdown annotations, content sync, reveal handling, and editor-local UI overlays. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: selection annotations are synchronized from Monaco editor selection and layout APIs, not derived React props. */
import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { toast } from 'sonner'
import type { MarkdownDocument } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { scrollTopCache, cursorPositionCache, setWithLRU } from '@/lib/scroll-cache'
import '@/lib/monaco-setup'
import { computeEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'
import { registerFileSearchSelectedTextProvider } from '@/lib/file-search-selection'

import { useContextualCopySetup } from './useContextualCopySetup'
import { MAX_REVEAL_CONTENT_WAIT_FRAMES, performReveal } from './monaco-reveal'
import {
  syncContentOnMount,
  syncContentUpdate,
  type MonacoContentSyncMode
} from './monaco-content-sync'
import { getMonacoCodebaseSearchQuery } from './monaco-codebase-search'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  shouldIgnoreMonacoContentChange
} from './monaco-programmatic-sync'
import {
  clearMarkdownDocCompletionDocuments,
  ensureMarkdownDocCompletionProvider,
  setMarkdownDocCompletionDocuments
} from './monaco-markdown-doc-completions'
import { MonacoGutterContextMenu } from './MonacoGutterContextMenu'
import {
  createMarkdownDocLinkDecorationController,
  type MarkdownDocLinkDecorationController
} from './monaco-markdown-doc-link-decorations'
import { buildGitConflictDecorations, hasGitConflictMarkers } from './monaco-conflict-decorations'
import { selectWorktreeDiffComments } from '@/store/worktree-diff-comments-selector'
import type { DiffComment } from '../../../../shared/types'
import { isMarkdownComment } from '@/lib/diff-comment-compat'
import { formatMarkdownReviewNotes, type MarkdownReviewNote } from '@/lib/markdown-review-notes'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import { DiffCommentPopover } from '../diff-comments/DiffCommentPopover'
import {
  getDiffCommentPopoverLeft,
  getDiffCommentPopoverTop
} from '../diff-comments/diff-comment-popover-position'
import { isLinuxUserAgent } from '../terminal-pane/pane-helpers'
import {
  installEditorAddReviewNoteShortcut,
  installEditorSaveShortcut,
  installMonacoEditorFindShortcut
} from './editor-shortcuts'
import { Plus } from 'lucide-react'
import {
  getMonacoMarkdownSelectionAnnotationTarget,
  type MonacoMarkdownSelectionAnnotationTarget
} from './monaco-markdown-selection-annotation'
import { translate } from '@/i18n/i18n'
import { handleMonacoLargeTextPaste } from './monaco-large-text-paste'
import { buildFileEditorWordWrapOptions } from './file-editor-word-wrap-options'
import {
  clampMonacoAutoHeight,
  getMonacoAutoHeightForContent,
  isMonacoAutoHeightCapped
} from './monaco-auto-height'
import { installMonacoE2EProbe } from './monaco-e2e-probe'

type MonacoEditorProps = {
  fileId: string
  filePath: string
  viewStateKey: string
  relativePath: string
  content: string
  language: string
  onContentChange: (content: string) => void
  onSave: (content: string) => void
  revealLine?: number
  revealColumn?: number
  revealMatchLength?: number
  markdownDocuments?: MarkdownDocument[]
  worktreeId?: string
  markdownAnnotationsEnabled?: boolean
  conflictDecorationsEnabled?: boolean
  readOnly?: boolean
  liveTail?: boolean
  autoHeight?: boolean
}

type MarkdownCommentPopoverState = Omit<MonacoMarkdownSelectionAnnotationTarget, 'selectedText'> & {
  selectedText?: string
}

export default function MonacoEditor({
  fileId,
  filePath,
  viewStateKey,
  relativePath,
  content,
  language,
  onContentChange,
  onSave,
  revealLine,
  revealColumn,
  revealMatchLength,
  markdownDocuments,
  worktreeId,
  markdownAnnotationsEnabled = false,
  conflictDecorationsEnabled = false,
  readOnly = false,
  liveTail = false,
  autoHeight = false
}: MonacoEditorProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const editorContainerRef = useRef<HTMLDivElement | null>(null)
  const [mountedEditor, setMountedEditor] = useState<editor.IStandaloneCodeEditor | null>(null)
  const [autoHeightContentHeight, setAutoHeightContentHeight] = useState<number | null>(null)
  const modelKeyRef = useRef<string | null>(null)
  const languageRef = useRef(language)
  languageRef.current = language
  const markdownDocLinkDecorationsRef = useRef<MarkdownDocLinkDecorationController | null>(null)
  const conflictDecorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const revealDecorationRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const revealHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)
  const unregisterFileSearchSelectionRef = useRef<(() => void) | null>(null)
  const { setupCopy, toastNode } = useContextualCopySetup()
  // Why: hold the throttle timer in a ref so unmount cleanup can cancel a pending write before snapshotting the final scroll position.
  const scrollThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const propsRef = useRef({ relativePath, language, onSave, onContentChange })
  // Why: assign during render so the ref is current before any handler reads it (a useEffect would leave a one-render stale window).
  propsRef.current = { relativePath, language, onSave, onContentChange }
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const contentSyncModeRef = useRef<MonacoContentSyncMode>('undoable')
  contentSyncModeRef.current = readOnly && liveTail ? 'read-only-live-tail' : 'undoable'

  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const setEditorCursorLine = useAppStore((s) => s.setEditorCursorLine)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    selectWorktreeDiffComments(s, worktreeId)
  )
  const editorFontSize = computeEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )
  const editorFontFamily = resolveEditorFontFamily(settings)
  const editorWordWrap = settings?.editorWordWrap
  const estimatedAutoHeight = useMemo(() => {
    if (!autoHeight) {
      return null
    }
    return getMonacoAutoHeightForContent(content, Math.ceil(editorFontSize * 1.45))
  }, [autoHeight, content, editorFontSize])
  const renderedEditorHeight = autoHeight
    ? (autoHeightContentHeight ?? estimatedAutoHeight ?? 80)
    : null
  const autoHeightLineHeight = Math.ceil(editorFontSize * 1.45)
  const autoHeightUsesInternalScroll =
    autoHeight && isMonacoAutoHeightCapped(renderedEditorHeight, autoHeightLineHeight)
  // Why: @monaco-editor/react skips its value→model sync on the first post-remount render, so retained models need an explicit sync or they show stale text.
  // Invariant: the mount path must read `contentRef.current` (guaranteed latest), never `lastSyncedContentRef.current` (may be stale pre-mount).
  const contentRef = useRef(content)
  contentRef.current = content
  const lastSyncedContentRef = useRef<string>(content)
  const markdownComments = useMemo(
    () =>
      (allDiffComments ?? []).filter((c) => c.filePath === relativePath && isMarkdownComment(c)),
    [allDiffComments, relativePath]
  )

  // Gutter context menu state
  const [gutterMenuOpen, setGutterMenuOpen] = useState(false)
  const [gutterMenuPoint, setGutterMenuPoint] = useState({ x: 0, y: 0 })
  const [gutterMenuLine, setGutterMenuLine] = useState(1)
  const [commentPopover, setCommentPopover] = useState<MarkdownCommentPopoverState | null>(null)
  const [selectionAnnotationTarget, setSelectionAnnotationTarget] =
    useState<MonacoMarkdownSelectionAnnotationTarget | null>(null)
  // Why: claim drafts synchronously so a same-tick second chord can't remount the composer before React commits state.
  const commentPopoverRef = useRef<MarkdownCommentPopoverState | null>(null)
  useEffect(() => {
    commentPopoverRef.current = commentPopover
  }, [commentPopover])
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const updateMarkdownCompletionDocuments = useCallback((): void => {
    const modelKey = editorRef.current?.getModel()?.uri.toString() ?? null
    if (modelKeyRef.current && modelKeyRef.current !== modelKey) {
      clearMarkdownDocCompletionDocuments(modelKeyRef.current)
    }
    modelKeyRef.current = modelKey
    if (!modelKey) {
      return
    }
    if (language === 'markdown' && markdownDocuments) {
      setMarkdownDocCompletionDocuments(modelKey, markdownDocuments)
    } else {
      clearMarkdownDocCompletionDocuments(modelKey)
    }
  }, [language, markdownDocuments])

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

  const clearTransientRevealHighlight = useCallback(() => {
    if (revealHighlightTimerRef.current !== null) {
      clearTimeout(revealHighlightTimerRef.current)
      revealHighlightTimerRef.current = null
    }
    revealDecorationRef.current?.clear()
    revealDecorationRef.current = null
  }, [])

  const cancelScheduledReveal = useCallback(() => {
    if (revealRafRef.current !== null) {
      cancelAnimationFrame(revealRafRef.current)
      revealRafRef.current = null
    }
    if (revealInnerRafRef.current !== null) {
      cancelAnimationFrame(revealInnerRafRef.current)
      revealInnerRafRef.current = null
    }
  }, [])

  const queueReveal = useCallback(
    (
      editorInstance: editor.IStandaloneCodeEditor,
      line: number,
      column: number,
      matchLength: number,
      onApplied?: () => void
    ) => {
      cancelScheduledReveal()
      let waitFrames = 0

      const schedule = (): void => {
        // Why: Monaco can mount before its viewport math settles, so defer the reveal two editor-owned frames for deterministic scroll/highlight.
        revealRafRef.current = requestAnimationFrame(() => {
          revealInnerRafRef.current = requestAnimationFrame(() => {
            revealRafRef.current = null
            revealInnerRafRef.current = null
            const modelLineCount = editorInstance.getModel()?.getLineCount() ?? 0
            if (line > 1 && modelLineCount < line && waitFrames < MAX_REVEAL_CONTENT_WAIT_FRAMES) {
              // Why: fresh opens can mount an empty 1-line model before the async read; waiting stops the target line clamping to 1.
              waitFrames += 2
              schedule()
              return
            }

            performReveal(
              editorInstance,
              line,
              column,
              matchLength,
              clearTransientRevealHighlight,
              revealDecorationRef,
              revealHighlightTimerRef
            )
            onApplied?.()
          })
        })
      }

      schedule()
    },
    [cancelScheduledReveal, clearTransientRevealHighlight]
  )

  // Why: reconciliation uses real edit ops (to keep undo sane), so these programmatic edits must suppress onChange or they'd mark the file dirty.
  const isApplyingProgrammaticContentRef = useRef(false)
  const isApplyingLargePasteRef = useRef(false)

  const handleMount: OnMount = useCallback(
    (editorInstance, monaco) => {
      editorRef.current = editorInstance
      setMountedEditor(editorInstance)
      const uninstallE2EProbe = installMonacoE2EProbe(editorInstance, filePath)
      let autoHeightSub: { dispose: () => void } | null = null
      let autoHeightFrame: number | null = null
      const updateAutoHeight = (): void => {
        if (!autoHeight) {
          return
        }
        if (autoHeightFrame !== null) {
          return
        }
        autoHeightFrame = window.requestAnimationFrame(() => {
          autoHeightFrame = null
          setAutoHeightContentHeight(
            clampMonacoAutoHeight(
              Math.ceil(editorInstance.getContentHeight()) + 1,
              autoHeightLineHeight
            )
          )
        })
      }
      if (autoHeight) {
        updateAutoHeight()
        autoHeightSub = editorInstance.onDidContentSizeChange(updateAutoHeight)
      }
      markdownDocLinkDecorationsRef.current = createMarkdownDocLinkDecorationController(
        editorInstance,
        () => languageRef.current
      )
      ensureMarkdownDocCompletionProvider(monaco)
      updateMarkdownCompletionDocuments()

      // Why: see contentRef — reconcile the retained model to the current prop before user interaction (surfaces edits made while unmounted).
      beginProgrammaticContentSync(filePath)
      isApplyingProgrammaticContentRef.current = true
      try {
        const didSyncOnMount = syncContentOnMount(
          editorInstance,
          contentRef.current,
          contentSyncModeRef.current
        )
        if (didSyncOnMount) {
          lastSyncedContentRef.current = contentRef.current
        }
      } finally {
        isApplyingProgrammaticContentRef.current = false
        endProgrammaticContentSync(filePath)
      }

      setupCopy(editorInstance, monaco, filePath, propsRef)
      unregisterFileSearchSelectionRef.current?.()
      unregisterFileSearchSelectionRef.current = registerFileSearchSelectedTextProvider(() => {
        if (!editorInstance.hasTextFocus()) {
          return null
        }
        const model = editorInstance.getModel()
        const selection = editorInstance.getSelection()
        if (!model || !selection || selection.isEmpty()) {
          return null
        }
        // Why: Monaco selections live in its text model, not the DOM selection API that app shortcuts read.
        return model.getValueInRange(selection)
      })

      const editorDomNode = editorInstance.getContainerDomNode()
      const cleanupSaveShortcut = installEditorSaveShortcut(editorDomNode, () => {
        const value = editorInstance.getValue()
        propsRef.current.onSave(value)
      })
      const cleanupFindShortcut = installMonacoEditorFindShortcut(editorInstance)
      // Opens the same composer as the selection "+" button.
      const cleanupAddReviewNoteShortcut = installEditorAddReviewNoteShortcut(editorDomNode, () => {
        // Why: keep an open draft instead of remounting, to avoid same-tick chord races before the composer guard runs.
        if (commentPopoverRef.current) {
          return true
        }
        if (!shouldShowMarkdownAnnotationsRef.current) {
          return false
        }
        // Why: the rendered target ref lags selection by a render, so read Monaco's live selection to avoid opening on a stale one.
        const target = getMonacoMarkdownSelectionAnnotationTarget(
          editorInstance,
          editorInstance.getSelection(),
          getDiffCommentPopoverLeft(editorInstance, editorContainerRef.current) ?? undefined
        )
        if (!target) {
          return false
        }
        commentPopoverRef.current = target
        setCommentPopover(target)
        setSelectionAnnotationTarget(null)
        return true
      })
      const searchInFilesAction = editorInstance.addAction({
        id: 'orca.searchInFiles',
        label: translate('auto.components.editor.MonacoEditor.fd68ae03b3', 'Search in Files'),
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 2,
        run: () => {
          if (!worktreeId) {
            return
          }
          const query = getMonacoCodebaseSearchQuery(
            editorInstance.getModel(),
            editorInstance.getSelection(),
            editorInstance.getPosition()
          )
          if (!query) {
            return
          }
          const state = useAppStore.getState()
          state.showRightSidebarSearch({ query })
        }
      })
      const onLargeTextPaste = (event: ClipboardEvent): void => {
        handleMonacoLargeTextPaste(editorInstance, event, {
          readOnly: readOnlyRef.current,
          onPasteStart: () => {
            isApplyingLargePasteRef.current = true
          },
          onPasteResult: (result) => {
            isApplyingLargePasteRef.current = false
            if (result.status === 'pasted' || result.status === 'cancelled') {
              const value = editorInstance.getValue()
              lastSyncedContentRef.current = value
              propsRef.current.onContentChange(value)
            }
            if (result.status === 'rejected' && result.reason === 'too-large') {
              toast.error(
                translate(
                  'auto.components.editor.MonacoEditor.largePasteTooLarge',
                  'Paste is too large.'
                )
              )
            }
          }
        })
      }
      editorDomNode.addEventListener('paste', onLargeTextPaste, { capture: true })

      // Track cursor line for "copy path to line" feature
      const pos = editorInstance.getPosition()
      if (pos) {
        setEditorCursorLine(filePath, pos.lineNumber)
      }
      const cursorPositionSub = editorInstance.onDidChangeCursorPosition((e) => {
        setEditorCursorLine(filePath, e.position.lineNumber)
        setWithLRU(cursorPositionCache, viewStateKey, {
          lineNumber: e.position.lineNumber,
          column: e.position.column
        })
      })

      // Why: only the resting scroll position matters, so trailing-throttle writes (~150ms) instead of writing every 60fps frame.
      const scrollStateSub = editorInstance.onDidScrollChange((e) => {
        if (scrollThrottleTimerRef.current !== null) {
          clearTimeout(scrollThrottleTimerRef.current)
        }
        scrollThrottleTimerRef.current = setTimeout(() => {
          setWithLRU(scrollTopCache, viewStateKey, e.scrollTop)
          scrollThrottleTimerRef.current = null
        }, 150)
      })

      // Why: custom Radix gutter menu instead of Monaco's built-in right-click menu (VSCode approach).
      const gutterMouseDownSub = editorInstance.onMouseDown((e) => {
        if (
          e.event.rightButton &&
          e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        ) {
          e.event.preventDefault()
          e.event.stopPropagation()
          const line = e.target.position?.lineNumber ?? 1
          editorInstance.setPosition({ lineNumber: line, column: 1 })
          setGutterMenuLine(line)
          setGutterMenuPoint({ x: e.event.posx, y: e.event.posy })
          setGutterMenuOpen(true)
        }
      })

      editorInstance.onDidDispose(() => {
        cursorPositionSub.dispose()
        scrollStateSub.dispose()
        gutterMouseDownSub.dispose()
        cleanupSaveShortcut()
        cleanupFindShortcut()
        cleanupAddReviewNoteShortcut()
        editorDomNode.removeEventListener('paste', onLargeTextPaste, { capture: true })
        searchInFilesAction.dispose()
        autoHeightSub?.dispose()
        if (autoHeightFrame !== null) {
          window.cancelAnimationFrame(autoHeightFrame)
          autoHeightFrame = null
        }
        conflictDecorationsRef.current?.clear()
        conflictDecorationsRef.current = null
        uninstallE2EProbe()
        editorRef.current = null
        setMountedEditor(null)
        setCommentPopover(null)
      })

      // If there's a pending reveal at mount time, execute it now
      const reveal = useAppStore.getState().pendingEditorReveal
      // Why: scope reveal consumption to the destination file, or the previously mounted editor clears it before openFile switches tabs.
      const revealMatchesEditor = reveal?.fileId
        ? reveal.fileId === fileId
        : reveal?.filePath === filePath
      if (reveal && revealMatchesEditor) {
        queueReveal(editorInstance, reveal.line, reveal.column, reveal.matchLength, () => {
          useAppStore.getState().setPendingEditorReveal(null)
        })
      } else {
        const savedCursor = cursorPositionCache.get(viewStateKey)
        const savedScrollTop = scrollTopCache.get(viewStateKey)
        if (savedScrollTop !== undefined || savedCursor) {
          // Why: Monaco renders synchronously so one RAF suffices; focus inside it to avoid a scroll-0 flash before restore.
          requestAnimationFrame(() => {
            if (savedCursor) {
              editorInstance.setPosition(savedCursor)
            }
            if (savedScrollTop !== undefined) {
              editorInstance.setScrollTop(savedScrollTop)
            }
            editorInstance.focus()
          })
        } else {
          editorInstance.focus()
        }
      }
    },
    [
      queueReveal,
      setupCopy,
      fileId,
      filePath,
      setEditorCursorLine,
      updateMarkdownCompletionDocuments,
      viewStateKey,
      autoHeight,
      autoHeightLineHeight,
      worktreeId
    ]
  )

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
  }, [commentPopover, mountedEditor, shouldShowMarkdownAnnotations])

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

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        // Why: split panes share one retained model, so a sibling must ignore the echoed programmatic-sync onChange or it marks the file dirty.
        if (isApplyingLargePasteRef.current) {
          lastSyncedContentRef.current = value
          return
        }
        if (
          shouldIgnoreMonacoContentChange({
            filePath,
            isApplyingProgrammaticContent: isApplyingProgrammaticContentRef.current
          })
        ) {
          return
        }
        lastSyncedContentRef.current = value
        onContentChange(value)
      }
    },
    [filePath, onContentChange]
  )

  // Why: sync the model on external `content` drift; useLayoutEffect lands the overwrite before paint so no stale text flashes. On-mount handled in handleMount.
  useLayoutEffect(() => {
    const ed = editorRef.current
    if (!ed || lastSyncedContentRef.current === content) {
      return
    }
    beginProgrammaticContentSync(filePath)
    isApplyingProgrammaticContentRef.current = true
    try {
      syncContentUpdate(ed, content, contentSyncModeRef.current)
      lastSyncedContentRef.current = content
    } finally {
      isApplyingProgrammaticContentRef.current = false
      endProgrammaticContentSync(filePath)
    }
  }, [content, filePath])

  // Why useLayoutEffect: cleanup runs before @monaco-editor/react disposes the editor, so getScrollTop() still reads valid state on unmount.
  useLayoutEffect(() => {
    return () => {
      // Why: cancel the pending throttled write so it can't fire after this snapshot and overwrite the final position with a stale value.
      if (scrollThrottleTimerRef.current !== null) {
        clearTimeout(scrollThrottleTimerRef.current)
        scrollThrottleTimerRef.current = null
      }
      const ed = editorRef.current
      if (ed) {
        setWithLRU(scrollTopCache, viewStateKey, ed.getScrollTop())
        const pos = ed.getPosition()
        if (pos) {
          setWithLRU(cursorPositionCache, viewStateKey, {
            lineNumber: pos.lineNumber,
            column: pos.column
          })
        }
      }
      cancelScheduledReveal()
      clearTransientRevealHighlight()
      unregisterFileSearchSelectionRef.current?.()
      unregisterFileSearchSelectionRef.current = null
    }
  }, [cancelScheduledReveal, clearTransientRevealHighlight, viewStateKey])

  // Update editor options when settings change
  useEffect(() => {
    if (!editorRef.current) {
      return
    }
    editorRef.current.updateOptions({
      fontSize: editorFontSize,
      fontFamily: editorFontFamily,
      ...buildFileEditorWordWrapOptions(editorWordWrap)
    })
  }, [editorFontFamily, editorFontSize, editorWordWrap])

  useEffect(() => {
    markdownDocLinkDecorationsRef.current?.refresh()
  }, [content, language])

  useEffect(() => {
    const ed = mountedEditor
    if (!ed) {
      return
    }

    if (!conflictDecorationsEnabled || !hasGitConflictMarkers(content)) {
      conflictDecorationsRef.current?.clear()
      return
    }

    // Why: conflict markers are ordinary file text, so Monaco needs explicit decorations to keep unresolved blocks visible.
    const decorations = buildGitConflictDecorations(content)
    if (!conflictDecorationsRef.current) {
      conflictDecorationsRef.current = ed.createDecorationsCollection(decorations)
      return
    }
    conflictDecorationsRef.current.set(decorations)
  }, [conflictDecorationsEnabled, content, mountedEditor])

  useEffect(() => {
    updateMarkdownCompletionDocuments()
  }, [updateMarkdownCompletionDocuments])

  useEffect(() => {
    return () => {
      if (modelKeyRef.current) {
        clearMarkdownDocCompletionDocuments(modelKeyRef.current)
      }
      markdownDocLinkDecorationsRef.current?.dispose()
      markdownDocLinkDecorationsRef.current = null
      conflictDecorationsRef.current?.clear()
      conflictDecorationsRef.current = null
    }
  }, [])

  // Navigate to line and highlight match when requested (for already-mounted editor)
  useEffect(() => {
    if (!revealLine || !editorRef.current) {
      return
    }
    queueReveal(editorRef.current, revealLine, revealColumn ?? 1, revealMatchLength ?? 0, () => {
      // Why: clear the pending payload only after the queued reveal runs, so navigation isn't lost if the editor unmounts first.
      setPendingEditorReveal(null)
    })
  }, [queueReveal, revealLine, revealColumn, revealMatchLength, setPendingEditorReveal])

  return (
    <div
      ref={editorContainerRef}
      className={autoHeight ? 'relative' : 'relative h-full'}
      style={renderedEditorHeight === null ? undefined : { height: renderedEditorHeight }}
    >
      {commentPopover && shouldShowMarkdownAnnotations && (
        <DiffCommentPopover
          key={commentPopover.lineNumber}
          lineNumber={commentPopover.lineNumber}
          startLine={commentPopover.startLine}
          top={commentPopover.top}
          left={commentPopover.left}
          onCancel={() => setCommentPopover(null)}
          onSubmit={handleSubmitMarkdownComment}
        />
      )}
      {selectionAnnotationTarget && shouldShowMarkdownAnnotations && !commentPopover ? (
        <button
          type="button"
          className="orca-diff-comment-add-btn"
          style={{
            display: 'flex',
            top: Math.max(4, selectionAnnotationTarget.top - 22),
            left: selectionAnnotationTarget.left ?? 4
          }}
          title={translate(
            'auto.components.editor.MonacoEditor.68cb83f4a7',
            'Add note on selected text'
          )}
          aria-label={translate(
            'auto.components.editor.MonacoEditor.68cb83f4a7',
            'Add note on selected text'
          )}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setCommentPopover(selectionAnnotationTarget)
            setSelectionAnnotationTarget(null)
          }}
        >
          <Plus className="size-3" />
        </button>
      ) : null}
      <Editor
        height={renderedEditorHeight === null ? '100%' : `${renderedEditorHeight}px`}
        language={language}
        // Why: defaultValue, not controlled value — Orca owns post-mount content sync; a controlled path would double setValue.
        defaultValue={content}
        theme={isDark ? 'vs-dark' : 'vs'}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          // Why: only the file editor honors this; Monaco 0.55 DiffEditor hard-overrides minimap.enabled=false on sub-editors (see diffEditorEditors._adjustOptionsForSubEditor).
          minimap: { enabled: settings?.editorMinimapEnabled ?? false },
          scrollBeyondLastLine: false,
          ...buildFileEditorWordWrapOptions(editorWordWrap),
          fontSize: editorFontSize,
          fontFamily: editorFontFamily,
          lineNumbers: 'on',
          renderLineHighlight: 'line',
          automaticLayout: true,
          tabSize: 2,
          readOnly,
          scrollbar: autoHeight
            ? {
                vertical: autoHeightUsesInternalScroll ? 'auto' : 'hidden',
                handleMouseWheel: autoHeightUsesInternalScroll
              }
            : undefined,
          smoothScrolling: true,
          cursorSmoothCaretAnimation: 'off',
          padding: { top: 0 },
          find: {
            addExtraSpaceOnTop: false,
            autoFindInSelection: 'never',
            seedSearchStringFromSelection: 'never'
          },
          // Why: Monaco owns its rendered line surface, so align its selection-clipboard with the app opt-out (the global DOM hook can't).
          selectionClipboard: settings?.primarySelectionMiddleClickPaste ?? isLinuxUserAgent()
        }}
        path={filePath}
        // Why: Orca owns cursor/scroll restoration, so disable @monaco-editor/react's competing view-state Map.
        saveViewState={false}
        keepCurrentModel
      />

      {toastNode}
      <MonacoGutterContextMenu
        open={gutterMenuOpen}
        onOpenChange={setGutterMenuOpen}
        point={gutterMenuPoint}
        line={gutterMenuLine}
        filePath={filePath}
        relativePath={relativePath}
      />
    </div>
  )
}
