import React, { useRef, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor, IRange } from 'monaco-editor'
import type { MarkdownDocument } from '../../../../shared/file-listing/file-document'
import { useAppStore } from '@/store'
import '@/lib/editor/monaco/monaco-setup'
import { monacoTypographyOptions } from '@/lib/editor/appearance/editor-typography'
import { useEditorTypography } from '@/hooks/use-editor-typography'
import { useContextualCopySetup } from './useContextualCopySetup'
import { MonacoGutterContextMenu } from './MonacoGutterContextMenu'
import { isLinuxUserAgent } from '../../lib/user-agent-platform'
import { MAX_TOKENIZATION_LINE_LENGTH } from '@/lib/monaco-languages/monarch-embed-entry-budget'
import { buildFileEditorWordWrapOptions } from './file-editor-word-wrap-options'
import { toEditorModelUri } from './model-lifetime/identity/editor-model-uri'
import { getEditorModelOwnerKey } from './model-lifetime/identity/editor-model-owner'
import {
  NO_RESOURCE_EVIDENCE,
  type WorkspaceResource
} from '@/lib/workspace/ownership/workspace-copy-owner'
import { getMonacoAutoHeightForContent, isMonacoAutoHeightCapped } from './monaco-auto-height'
import { monacoFindOptions } from './monaco-find-options'
import { buildEditorUnicodeHighlightOptions } from './editor-unicode-highlight-options'
import { useMonacoRevealScheduler } from './use-monaco-reveal-scheduler'
import type { MonacoContentSyncMode } from './monaco-content-sync'
import { useMonacoContentSyncBridge } from './use-monaco-content-sync-bridge'
import { useMonacoMarkdownAnnotations } from './markdown-source-tools/monaco/use-monaco-markdown-annotations'
import { useMonacoEditorDecorations } from './use-monaco-editor-decorations'
import { useMonacoEditorMount } from './use-monaco-editor-mount'
import { snapshotMonacoViewState } from './monaco-view-state-persistence'
import { MonacoMarkdownAnnotationOverlay } from './markdown-source-tools/monaco/MonacoMarkdownAnnotationOverlay'
import { usePluginSyntaxLanguage } from './use-plugin-syntax-language'
import {
  PLUGIN_SYNTAX_EDITOR_OPTIONS,
  applyModelLanguage
} from '@/lib/monaco-languages/plugin-syntax-editor-options'
import { useMonacoTheme } from '@/hooks/use-monaco-theme'
import { useEditorModelRekeyCarry } from './model-lifetime/identity/editor-model-rekey-carry'
import { installMonacoVimMode } from './monaco-vim-mode'
import { VimCheatsheet } from './VimCheatsheet'

/** Reserved height (px) for the Vim status bar row; keep in sync with the render class. */
const VIM_STATUS_BAR_HEIGHT = 22

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
  /** The open file's tab; its review notes belong to the copy it names. */
  noteSource?: WorkspaceResource
  markdownAnnotationsEnabled?: boolean
  conflictDecorationsEnabled?: boolean
  readOnly?: boolean
  // Why: shows another tab's record read-only; never moves its cursor line or takes its reveals.
  passiveMirror?: boolean
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
  language: coreLanguage,
  onContentChange,
  onSave,
  revealLine,
  revealColumn,
  revealMatchLength,
  markdownDocuments,
  worktreeId,
  noteSource = NO_RESOURCE_EVIDENCE,
  markdownAnnotationsEnabled = false,
  conflictDecorationsEnabled = false,
  readOnly = false,
  passiveMirror = false,
  liveTail = false,
  autoHeight = false
}: MonacoEditorProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const editorContainerRef = useRef<HTMLDivElement | null>(null)
  // Why: the editor + overlays live in their own flex child so the Vim status bar can occupy a
  // real row below the editor instead of overlapping it.
  const editorBodyRef = useRef<HTMLDivElement | null>(null)
  const vimStatusBarRef = useRef<HTMLDivElement | null>(null)
  const [mountedEditor, setMountedEditor] = useState<editor.IStandaloneCodeEditor | null>(null)
  const [autoHeightContentHeight, setAutoHeightContentHeight] = useState<number | null>(null)
  const language = usePluginSyntaxLanguage(filePath, coreLanguage)
  const languageRef = useRef(language)
  languageRef.current = language
  useEffect(
    () => applyModelLanguage([mountedEditor?.getModel()], language),
    [mountedEditor, language]
  )
  const unregisterFileSearchSelectionRef = useRef<(() => void) | null>(null)
  const { setupCopy, toastNode } = useContextualCopySetup()
  // Cancel pending throttled writes before snapshotting final scroll on unmount.
  const scrollThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeFile = useAppStore((s) => s.closeFile)
  const propsRef = useRef({ relativePath, language, onSave, onContentChange, fileId, closeFile })
  // Why: assign during render so the ref is current before any handler reads it (a useEffect would leave a one-render stale window).
  propsRef.current = { relativePath, language, onSave, onContentChange, fileId, closeFile }
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const contentSyncModeRef = useRef<MonacoContentSyncMode>('undoable')
  contentSyncModeRef.current = readOnly && liveTail ? 'read-only-live-tail' : 'undoable'

  const settings = useAppStore((s) => s.settings)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const setEditorCursorLine = useAppStore((s) => s.setEditorCursorLine)
  const typography = useEditorTypography()
  const typographyOptions = useMemo(() => monacoTypographyOptions(typography), [typography])
  // Mirrors Monaco's automatic spacing closely enough to size before mount.
  const autoHeightLineHeight = typography.lineHeight || Math.ceil(typography.fontSize * 1.45)
  const editorWordWrap = settings?.editorWordWrap
  const modelOwnerKey = useAppStore((state) => {
    const file = state.openFiles?.find((entry) => entry.id === fileId)
    return file
      ? getEditorModelOwnerKey(file, state)
      : JSON.stringify([null, `unresolved:${fileId}`])
  })
  const modelUri = useMemo(
    () => toEditorModelUri(filePath, modelOwnerKey),
    [filePath, modelOwnerKey]
  )
  useEditorModelRekeyCarry(fileId, modelUri)
  // Why: Vim's modal editing and status bar only apply to the editable, full-height file editor —
  // not read-only diffs or the auto-height inline editors used for previews.
  const vimModeEnabled =
    (settings?.editorKeybindings ?? 'default') === 'vim' && !readOnly && !autoHeight
  const estimatedAutoHeight = useMemo(() => {
    if (!autoHeight) {
      return null
    }
    return getMonacoAutoHeightForContent(content, autoHeightLineHeight)
  }, [autoHeight, content, autoHeightLineHeight])
  const renderedEditorHeight = autoHeight
    ? (autoHeightContentHeight ?? estimatedAutoHeight ?? 80)
    : null
  const autoHeightUsesInternalScroll =
    autoHeight && isMonacoAutoHeightCapped(renderedEditorHeight, autoHeightLineHeight)
  // The React wrapper skips first post-remount value sync; reconcile retained models from live contentRef, never the possibly stale lastSyncedContentRef.
  const contentRef = useRef(content)
  contentRef.current = content
  const [gutterMenuOpen, setGutterMenuOpen] = useState(false)
  const [gutterMenuPoint, setGutterMenuPoint] = useState({ x: 0, y: 0 })
  const [gutterMenuLine, setGutterMenuLine] = useState(1)
  const [gutterMenuSelection, setGutterMenuSelection] = useState<IRange | null>(null)
  const monacoTheme = useMonacoTheme()

  const { queueReveal, cancelScheduledReveal, clearTransientRevealHighlight } =
    useMonacoRevealScheduler()
  const contentSync = useMonacoContentSyncBridge({
    editorRef,
    mountedEditor,
    content,
    contentRef,
    contentSyncModeRef,
    modelKey: modelUri,
    fileId,
    onContentChange
  })
  const annotations = useMonacoMarkdownAnnotations({
    mountedEditor,
    editorContainerRef,
    relativePath,
    content,
    language,
    worktreeId,
    noteSource,
    markdownAnnotationsEnabled
  })

  // Layout cleanup precedes the wrapper’s editor disposal, keeping final scroll readable.
  useLayoutEffect(() => {
    return () => {
      // Cancel throttled writes so stale positions cannot overwrite the final snapshot.
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
  }, [cancelScheduledReveal, clearTransientRevealHighlight, modelUri, viewStateKey])

  useEffect(() => {
    if (!editorRef.current) {
      return
    }
    editorRef.current.updateOptions({
      ...typographyOptions,
      ...buildFileEditorWordWrapOptions(editorWordWrap),
      readOnly
    })
  }, [typographyOptions, editorWordWrap, readOnly])

  // Why: install Vim keybindings on the mounted editor and tear them down when the setting flips
  // or the editor unmounts, so toggling never leaks a stale adapter. monaco-vim loads lazily, so
  // guard against the editor unmounting before the import settles.
  useEffect(() => {
    const ed = mountedEditor
    const statusNode = vimStatusBarRef.current
    if (!ed || !vimModeEnabled || !statusNode) {
      return
    }
    let cancelled = false
    let controller: { dispose: () => void } | null = null
    void installMonacoVimMode(ed, statusNode, {
      onWrite: () => propsRef.current.onSave(ed.getValue()),
      onClose: () => propsRef.current.closeFile(propsRef.current.fileId),
      editor: ed
    })
      .then((installed) => {
        if (cancelled) {
          installed.dispose()
        } else {
          controller = installed
        }
      })
      .catch((error) => {
        console.error('Failed to enable Vim keybindings', error)
      })
    return () => {
      cancelled = true
      controller?.dispose()
    }
  }, [mountedEditor, vimModeEnabled])

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
    modelOwnerKey,
    viewStateKey,
    viewStateId,
    passiveMirror,
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
    gutterMenu: {
      setGutterMenuOpen,
      setGutterMenuPoint,
      setGutterMenuLine,
      setGutterMenuSelection
    }
  })

  useEffect(() => {
    if (!revealLine || !editorRef.current) {
      return
    }
    const reveal = useAppStore.getState().pendingEditorReveal
    if (reveal?.viewStateId && (reveal.fileId !== fileId || reveal.viewStateId !== viewStateId)) {
      return
    }
    queueReveal(
      editorRef.current,
      revealLine,
      revealColumn ?? 1,
      revealMatchLength ?? 0,
      () => {
        reveal?.onApplied?.()
        // Why: a newer request may arrive during the editor-owned reveal frames.
        if (useAppStore.getState().pendingEditorReveal === reveal) {
          setPendingEditorReveal(null)
        }
      },
      reveal?.canApply
        ? () =>
            useAppStore.getState().pendingEditorReveal === reveal && reveal.canApply?.() !== false
        : undefined
    )
  }, [
    queueReveal,
    revealLine,
    revealColumn,
    revealMatchLength,
    setPendingEditorReveal,
    fileId,
    viewStateId
  ])

  return (
    <div
      ref={editorContainerRef}
      data-orca-file-editor
      // Why: a flex column lets the Vim status bar occupy a real row below the editor instead of
      // overlaying it. autoHeight editors are content-sized (and never show the bar), so they keep
      // the plain block layout.
      className={autoHeight ? 'relative' : 'flex h-full flex-col'}
      style={renderedEditorHeight === null ? undefined : { height: renderedEditorHeight }}
    >
      <div ref={editorBodyRef} className={autoHeight ? 'relative' : 'relative min-h-0 flex-1'}>
        <MonacoMarkdownAnnotationOverlay
          shouldShowMarkdownAnnotations={annotations.shouldShowMarkdownAnnotations}
          commentPopover={annotations.commentPopover}
          setCommentPopover={annotations.setCommentPopover}
          selectionAnnotationTarget={annotations.selectionAnnotationTarget}
          setSelectionAnnotationTarget={annotations.setSelectionAnnotationTarget}
          onSubmitMarkdownComment={annotations.handleSubmitMarkdownComment}
        />
        <Editor
          key={modelUri}
          height={renderedEditorHeight === null ? '100%' : `${renderedEditorHeight}px`}
          language={language}
          // Use defaultValue because Orca owns later content sync; controlled values would duplicate setValue.
          defaultValue={content}
          theme={monacoTheme}
          onMount={handleMount}
          options={{
            dropIntoEditor: { enabled: false },
            // This global option also affects diff and Peek; it is defense in depth, not protection from Monarch embedding recursion below the cap.
            maxTokenizationLineLength: MAX_TOKENIZATION_LINE_LENGTH,
            // Monaco 0.55 forcibly disables diff sub-editor minimaps; only file editors honor this setting.
            minimap: { enabled: settings?.editorMinimapEnabled ?? false },
            scrollBeyondLastLine: false,
            ...PLUGIN_SYNTAX_EDITOR_OPTIONS,
            ...buildFileEditorWordWrapOptions(editorWordWrap),
            ...typographyOptions,
            lineNumbers: 'on',
            renderLineHighlight: 'line',
            automaticLayout: true,
            unicodeHighlight: buildEditorUnicodeHighlightOptions(language),
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
            // Monaco owns rendered lines, so its selection clipboard must enforce the app opt-out independently of the global DOM hook.
            selectionClipboard: settings?.primarySelectionMiddleClickPaste ?? isLinuxUserAgent()
          }}
          // Build a model URI because the React wrapper’s Uri.parse treats Windows drive letters as schemes.
          path={modelUri}
          // Orca owns cursor/scroll restoration; disable the wrapper’s competing view-state map.
          saveViewState={false}
          keepCurrentModel
        />

        {toastNode}
        <MonacoGutterContextMenu
          open={gutterMenuOpen}
          onOpenChange={setGutterMenuOpen}
          point={gutterMenuPoint}
          line={gutterMenuLine}
          selection={gutterMenuSelection}
          fileId={fileId}
          filePath={filePath}
          relativePath={relativePath}
          worktreeId={worktreeId}
        />
      </div>

      {vimModeEnabled ? (
        <div
          // Why: the monaco-vim status node must stay a dedicated element the adapter owns, so the
          // cheatsheet hint lives as a sibling in this row rather than inside the node React and
          // monaco-vim would otherwise both mutate.
          className="flex shrink-0 items-center gap-2 border-t border-border bg-editor-surface px-2"
          style={{ height: VIM_STATUS_BAR_HEIGHT }}
        >
          <div
            ref={vimStatusBarRef}
            data-orca-vim-statusbar
            className="min-w-0 flex-1 overflow-hidden font-mono text-xs text-muted-foreground"
          />
          <VimCheatsheet />
        </div>
      ) : null}
    </div>
  )
}
