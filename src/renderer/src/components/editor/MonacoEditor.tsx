/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: selection annotations are synchronized from Monaco editor selection and layout APIs, not derived React props. */
import React, { useRef, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { useAppStore } from '@/store'
import '@/lib/monaco-setup'
import { computeEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'

import { useContextualCopySetup } from './useContextualCopySetup'
import { MonacoGutterContextMenu } from './MonacoGutterContextMenu'
import { isLinuxUserAgent } from '../terminal-pane/pane-helpers'
import { buildFileEditorWordWrapOptions } from './file-editor-word-wrap-options'
import { getMonacoAutoHeightForContent, isMonacoAutoHeightCapped } from './monaco-auto-height'
import { monacoFindOptions } from './monaco-find-options'
import { useMonacoRevealScheduler } from './use-monaco-reveal-scheduler'
import type { MonacoContentSyncMode } from './monaco-content-sync'
import { useMonacoContentSyncBridge } from './use-monaco-content-sync-bridge'
import { useMonacoMarkdownAnnotations } from './use-monaco-markdown-annotations'
import { useMonacoEditorDecorations } from './use-monaco-editor-decorations'
import { useMonacoEditorMount } from './use-monaco-editor-mount'
import { snapshotMonacoViewState } from './monaco-view-state-persistence'
import { MonacoMarkdownAnnotationOverlay } from './MonacoMarkdownAnnotationOverlay'

type MonacoEditorProps = {
  fileId: string
  filePath: string
  viewStateKey: string
  // Why: identifies the pane for explicit open focus handoffs; omit on surfaces that never receive one.
  viewStateId?: string
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

export default function MonacoEditor({
  fileId,
  filePath,
  viewStateKey,
  viewStateId,
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
  const languageRef = useRef(language)
  languageRef.current = language
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
  // Gutter context menu state
  const [gutterMenuOpen, setGutterMenuOpen] = useState(false)
  const [gutterMenuPoint, setGutterMenuPoint] = useState({ x: 0, y: 0 })
  const [gutterMenuLine, setGutterMenuLine] = useState(1)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const { queueReveal, cancelScheduledReveal, clearTransientRevealHighlight } =
    useMonacoRevealScheduler()
  const contentSync = useMonacoContentSyncBridge({
    editorRef,
    content,
    contentRef,
    contentSyncModeRef,
    filePath,
    onContentChange
  })
  const annotations = useMonacoMarkdownAnnotations({
    mountedEditor,
    editorContainerRef,
    relativePath,
    content,
    language,
    worktreeId,
    markdownAnnotationsEnabled
  })

  // Why useLayoutEffect: cleanup runs before @monaco-editor/react disposes the editor, so getScrollTop() still reads valid state on unmount.
  useLayoutEffect(() => {
    return () => {
      // Why: cancel the pending throttled write so it can't fire after this snapshot and overwrite the final position with a stale value.
      if (scrollThrottleTimerRef.current !== null) {
        clearTimeout(scrollThrottleTimerRef.current)
        scrollThrottleTimerRef.current = null
      }
      snapshotMonacoViewState(editorRef, viewStateKey)
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

  const decorations = useMonacoEditorDecorations({
    editorRef,
    mountedEditor,
    content,
    language,
    markdownDocuments,
    conflictDecorationsEnabled
  })

  const handleMount = useMonacoEditorMount({
    fileId,
    filePath,
    viewStateKey,
    viewStateId,
    worktreeId,
    autoHeight,
    autoHeightLineHeight,
    editorRef,
    editorContainerRef,
    languageRef,
    propsRef,
    readOnlyRef,
    scrollThrottleTimerRef,
    unregisterFileSearchSelectionRef,
    setMountedEditor,
    setAutoHeightContentHeight,
    setEditorCursorLine,
    setupCopy,
    queueReveal,
    contentSync,
    decorations,
    annotations,
    gutterMenu: { setGutterMenuOpen, setGutterMenuPoint, setGutterMenuLine }
  })

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
      <MonacoMarkdownAnnotationOverlay
        shouldShowMarkdownAnnotations={annotations.shouldShowMarkdownAnnotations}
        commentPopover={annotations.commentPopover}
        setCommentPopover={annotations.setCommentPopover}
        selectionAnnotationTarget={annotations.selectionAnnotationTarget}
        setSelectionAnnotationTarget={annotations.setSelectionAnnotationTarget}
        onSubmitMarkdownComment={annotations.handleSubmitMarkdownComment}
      />
      <Editor
        height={renderedEditorHeight === null ? '100%' : `${renderedEditorHeight}px`}
        language={language}
        // Why: defaultValue, not controlled value — Orca owns post-mount content sync; a controlled path would double setValue.
        defaultValue={content}
        theme={isDark ? 'vs-dark' : 'vs'}
        onChange={contentSync.handleChange}
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
          find: monacoFindOptions,
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
