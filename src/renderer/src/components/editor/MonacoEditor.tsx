import React, { useRef, useCallback, useEffect, useLayoutEffect, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { MarkdownDocument } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { scrollTopCache, cursorPositionCache, setWithLRU } from '@/lib/scroll-cache'
import '@/lib/monaco-setup'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'

import { useContextualCopySetup } from './useContextualCopySetup'
import { performReveal } from './monaco-reveal'
import { syncContentOnMount, syncContentUpdate } from './monaco-content-sync'
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

type MonacoEditorProps = {
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
}

export default function MonacoEditor({
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
  markdownDocuments
}: MonacoEditorProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const modelKeyRef = useRef<string | null>(null)
  const languageRef = useRef(language)
  languageRef.current = language
  const markdownDocLinkDecorationsRef = useRef<MarkdownDocLinkDecorationController | null>(null)
  const revealDecorationRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const revealHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)
  const { setupCopy, toastNode } = useContextualCopySetup()
  // Why: The scroll throttle timer must be accessible from useLayoutEffect cleanup
  // so we can cancel any pending write before synchronously snapshotting the final
  // scroll position on unmount. Without this, a pending timer could fire after
  // cleanup and overwrite the correct value with a stale one.
  const scrollThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const propsRef = useRef({ relativePath, language, onSave })
  // Why: assigning during render keeps the ref current before any event handler
  // or effect reads it, avoiding the one-render stale window that a useEffect
  // would introduce. Refs are mutable and don't trigger re-renders, so this is
  // safe to do unconditionally every render.
  propsRef.current = { relativePath, language, onSave }

  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const setEditorCursorLine = useAppStore((s) => s.setEditorCursorLine)
  const editorFontSize = computeEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )

  // Gutter context menu state
  const [gutterMenuOpen, setGutterMenuOpen] = useState(false)
  const [gutterMenuPoint, setGutterMenuPoint] = useState({ x: 0, y: 0 })
  const [gutterMenuLine, setGutterMenuLine] = useState(1)
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

      // Why: the search click path already waits two frames before publishing
      // the reveal intent, but Monaco can still mount before its viewport math
      // settles. Deferring the actual reveal by two editor-owned frames keeps
      // scroll-to-match and inline highlight deterministic on fresh opens.
      revealRafRef.current = requestAnimationFrame(() => {
        revealInnerRafRef.current = requestAnimationFrame(() => {
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
          revealRafRef.current = null
          revealInnerRafRef.current = null
        })
      })
    },
    [cancelScheduledReveal, clearTransientRevealHighlight]
  )

  // Why: `keepCurrentModel` retains Monaco models across unmounts, and
  // @monaco-editor/react skips its value→model sync on the first render after
  // a remount. Without explicit sync, external file changes that arrived
  // while the tab was unmounted leave the retained model showing stale text.
  // contentRef lets handleMount read the current content without re-binding;
  // lastSyncedContentRef lets the update effect distinguish our own onChange
  // emissions from real prop drift.
  // Invariant: the mount path (handleMount's syncContentOnMount call) MUST
  // read `contentRef.current`, never `lastSyncedContentRef.current`. The
  // useLayoutEffect below can run before mount with `editorRef.current === null`
  // and bails without updating lastSyncedContentRef, so that ref may be stale
  // pre-mount; only contentRef is guaranteed to reflect the latest prop.
  const contentRef = useRef(content)
  contentRef.current = content
  const lastSyncedContentRef = useRef<string>(content)
  // Why: Monaco model reconciliation reuses real edit operations so retained
  // models keep sane undo behavior. Those edits are programmatic, not user
  // typing, so split panes must suppress the resulting onChange callback or a
  // freshly mounted markdown source view can mark the shared file dirty.
  const isApplyingProgrammaticContentRef = useRef(false)

  const handleMount: OnMount = useCallback(
    (editorInstance, monaco) => {
      editorRef.current = editorInstance
      markdownDocLinkDecorationsRef.current = createMarkdownDocLinkDecorationController(
        editorInstance,
        () => languageRef.current
      )
      ensureMarkdownDocCompletionProvider(monaco)
      updateMarkdownCompletionDocuments()

      // Why: see comment on contentRef — reconcile the retained model against
      // the current prop before any user interaction so external changes that
      // arrived while the tab was unmounted become visible immediately.
      beginProgrammaticContentSync(filePath)
      isApplyingProgrammaticContentRef.current = true
      try {
        const didSyncOnMount = syncContentOnMount(editorInstance, contentRef.current)
        if (didSyncOnMount) {
          lastSyncedContentRef.current = contentRef.current
        }
      } finally {
        isApplyingProgrammaticContentRef.current = false
        endProgrammaticContentSync(filePath)
      }

      setupCopy(editorInstance, monaco, filePath, propsRef)

      // Add Cmd+S save keybinding
      editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        const value = editorInstance.getValue()
        propsRef.current.onSave(value)
      })

      // Track cursor line for "copy path to line" feature
      const pos = editorInstance.getPosition()
      if (pos) {
        setEditorCursorLine(filePath, pos.lineNumber)
      }
      editorInstance.onDidChangeCursorPosition((e) => {
        setEditorCursorLine(filePath, e.position.lineNumber)
        setWithLRU(cursorPositionCache, viewStateKey, {
          lineNumber: e.position.lineNumber,
          column: e.position.column
        })
      })

      // Why: Writing to the Map at 60fps (every scroll frame) is unnecessary since
      // we only need the final position when the user stops scrolling or switches
      // tabs. A trailing throttle of ~150ms captures the resting position while
      // avoiding excessive writes.
      editorInstance.onDidScrollChange((e) => {
        if (scrollThrottleTimerRef.current !== null) {
          clearTimeout(scrollThrottleTimerRef.current)
        }
        scrollThrottleTimerRef.current = setTimeout(() => {
          setWithLRU(scrollTopCache, viewStateKey, e.scrollTop)
          scrollThrottleTimerRef.current = null
        }, 150)
      })

      // Intercept right-click on line number gutter to show Radix context menu
      // (same approach as VSCode: custom menu instead of Monaco's built-in one)
      editorInstance.onMouseDown((e) => {
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

      // If there's a pending reveal at mount time, execute it now
      const reveal = useAppStore.getState().pendingEditorReveal
      // Why: search-result navigation sets the reveal before openFile switches
      // the active tab. Without scoping consumption to the destination file,
      // the previously mounted editor can clear the reveal on the first click.
      if (reveal?.filePath === filePath) {
        queueReveal(editorInstance, reveal.line, reveal.column, reveal.matchLength, () => {
          useAppStore.getState().setPendingEditorReveal(null)
        })
      } else {
        const savedCursor = cursorPositionCache.get(viewStateKey)
        const savedScrollTop = scrollTopCache.get(viewStateKey)
        if (savedScrollTop !== undefined || savedCursor) {
          // Why: Monaco renders synchronously, so a single RAF is sufficient to
          // wait for the layout pass. Unlike react-markdown or Tiptap, there is
          // no async content loading that would require a retry loop.
          // Focus is deferred into the same RAF to avoid a one-frame flash where
          // the editor is focused at scroll position 0 before restoration.
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
      filePath,
      setEditorCursorLine,
      updateMarkdownCompletionDocuments,
      viewStateKey
    ]
  )

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        // Why: split panes that share a retained Monaco model all receive the
        // same model change events. When one pane is reconciling prop content
        // into the shared model, sibling panes must ignore the echoed onChange
        // or they'll treat the programmatic sync as a user edit and mark the
        // shared file dirty.
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

  // Why: reconcile the model whenever `content` drifts from what we last
  // synced (covers external file changes while mounted). The on-mount case
  // is handled directly in handleMount. useLayoutEffect lets the overwrite
  // land before paint so the user never sees stale text.
  useLayoutEffect(() => {
    const ed = editorRef.current
    if (!ed || lastSyncedContentRef.current === content) {
      return
    }
    beginProgrammaticContentSync(filePath)
    isApplyingProgrammaticContentRef.current = true
    try {
      syncContentUpdate(ed, content)
      lastSyncedContentRef.current = content
    } finally {
      isApplyingProgrammaticContentRef.current = false
      endProgrammaticContentSync(filePath)
    }
  }, [content, filePath])

  // Snapshot scroll position synchronously on unmount so tab switches always
  // capture the latest value, even if the trailing throttle hasn't fired yet.
  // Why useLayoutEffect: cleanup runs before @monaco-editor/react's useEffect
  // disposes the editor instance, guaranteeing getScrollTop() reads valid state.
  useLayoutEffect(() => {
    return () => {
      // Why: Cancel any pending throttled scroll write so it cannot fire after
      // this synchronous snapshot, which would overwrite the correct final
      // position with a stale intermediate value.
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
    }
  }, [cancelScheduledReveal, clearTransientRevealHighlight, viewStateKey])

  // Update editor options when settings change
  useEffect(() => {
    if (!editorRef.current || !settings) {
      return
    }
    editorRef.current.updateOptions({
      fontSize: editorFontSize,
      fontFamily: settings.terminalFontFamily || 'monospace'
    })
  }, [editorFontSize, settings])

  useEffect(() => {
    markdownDocLinkDecorationsRef.current?.refresh()
  }, [content, language])

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
    }
  }, [])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent).detail as
        | { filePath?: string; line?: number; column?: number | null }
        | undefined
      if (!detail || detail.filePath !== filePath || !detail.line) {
        return
      }
      const editor = editorRef.current
      if (!editor) {
        return
      }
      const targetColumn = Math.max(1, detail.column ?? 1)
      const targetLine = Math.max(1, detail.line)
      editor.revealPositionInCenter({ lineNumber: targetLine, column: targetColumn })
      editor.setPosition({ lineNumber: targetLine, column: targetColumn })
      editor.focus()
    }

    window.addEventListener('orca:editor-reveal-location', handler as EventListener)
    return () => window.removeEventListener('orca:editor-reveal-location', handler as EventListener)
  }, [filePath])

  // Navigate to line and highlight match when requested (for already-mounted editor)
  useEffect(() => {
    if (!revealLine || !editorRef.current) {
      return
    }
    queueReveal(editorRef.current, revealLine, revealColumn ?? 1, revealMatchLength ?? 0, () => {
      // Why: the reveal is intentionally delayed until Monaco finishes its
      // own post-mount layout frames. Clearing the pending payload only after
      // the queued reveal runs prevents lost navigation if the editor
      // unmounts before those frames execute.
      setPendingEditorReveal(null)
    })
  }, [queueReveal, revealLine, revealColumn, revealMatchLength, setPendingEditorReveal])

  return (
    <div className="relative h-full">
      <Editor
        height="100%"
        language={language}
        value={content}
        theme={isDark ? 'vs-dark' : 'vs'}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          fontSize: editorFontSize,
          fontFamily: settings?.terminalFontFamily || 'monospace',
          lineNumbers: 'on',
          renderLineHighlight: 'line',
          automaticLayout: true,
          tabSize: 2,
          smoothScrolling: true,
          cursorSmoothCaretAnimation: 'off',
          padding: { top: 0 },
          find: {
            addExtraSpaceOnTop: false,
            autoFindInSelection: 'never',
            seedSearchStringFromSelection: 'never'
          }
        }}
        path={filePath}
        // Why: keepCurrentModel preserves the Monaco text model so undo/redo
        // survives tab switches, but @monaco-editor/react's own view-state Map
        // would become a second state owner. Orca restores cursor/scroll from
        // its explicit caches so close/reopen semantics stay under app control.
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
