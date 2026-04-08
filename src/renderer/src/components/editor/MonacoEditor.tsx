import React, { useRef, useCallback, useEffect, useLayoutEffect, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { Copy, ExternalLink } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import '@/lib/monaco-setup'
import { setupContextualCopy } from './setup-contextual-copy'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'

type MonacoEditorProps = {
  filePath: string
  relativePath: string
  content: string
  language: string
  onContentChange: (content: string) => void
  onSave: (content: string) => void
  revealLine?: number
  revealColumn?: number
  revealMatchLength?: number
}

export default function MonacoEditor({
  filePath,
  relativePath,
  content,
  language,
  onContentChange,
  onSave,
  revealLine,
  revealColumn,
  revealMatchLength
}: MonacoEditorProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const copyToastTimeoutRef = useRef<number | null>(null)
  const copyHintIntervalRef = useRef<number | null>(null)
  // Why: The scroll throttle timer must be accessible from useLayoutEffect cleanup
  // so we can cancel any pending write before synchronously snapshotting the final
  // scroll position on unmount. Without this, a pending timer could fire after
  // cleanup and overwrite the correct value with a stale one.
  const scrollThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const propsRef = useRef({ relativePath, language, onSave })

  useEffect(() => {
    propsRef.current = { relativePath, language, onSave }
  }, [relativePath, language, onSave])

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
  const [copyToast, setCopyToast] = useState<{ left: number; top: number } | null>(null)
  const isMac = navigator.userAgent.includes('Mac')
  const copyShortcutLabel = isMac ? '⌥⌘C' : 'Ctrl+Alt+C'
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const handleMount: OnMount = useCallback(
    (editorInstance, monaco) => {
      editorRef.current = editorInstance

      setupContextualCopy({
        editorInstance,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        monaco: monaco as any,
        filePath,
        copyShortcutLabel,
        setCopyToast,
        propsRef,
        copyToastTimeoutRef,
        copyHintIntervalRef
      })

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
          setWithLRU(scrollTopCache, filePath, e.scrollTop)
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
        performReveal(editorInstance, reveal.line, reveal.column, reveal.matchLength)
        useAppStore.getState().setPendingEditorReveal(null)
      } else {
        const savedScrollTop = scrollTopCache.get(filePath)
        if (savedScrollTop !== undefined) {
          // Why: Monaco renders synchronously, so a single RAF is sufficient to
          // wait for the layout pass. Unlike react-markdown or Tiptap, there is
          // no async content loading that would require a retry loop.
          // Focus is deferred into the same RAF to avoid a one-frame flash where
          // the editor is focused at scroll position 0 before restoration.
          requestAnimationFrame(() => {
            editorInstance.setScrollTop(savedScrollTop)
            editorInstance.focus()
          })
        } else {
          editorInstance.focus()
        }
      }
    },
    [copyShortcutLabel, filePath, setEditorCursorLine]
  )

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        onContentChange(value)
      }
    },
    [onContentChange]
  )

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
        setWithLRU(scrollTopCache, filePath, ed.getScrollTop())
      }
    }
  }, [filePath])

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
    const toastRef = copyToastTimeoutRef
    const hintRef = copyHintIntervalRef
    return () => {
      if (toastRef.current !== null) {
        window.clearTimeout(toastRef.current)
      }
      if (hintRef.current !== null) {
        window.clearInterval(hintRef.current)
      }
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
    performReveal(editorRef.current, revealLine, revealColumn ?? 1, revealMatchLength ?? 0)
    // Clear after consuming so it doesn't re-fire
    setPendingEditorReveal(null)
  }, [revealLine, revealColumn, revealMatchLength, setPendingEditorReveal])

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
      />

      {copyToast ? (
        <div
          className="pointer-events-none fixed z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm"
          style={{ left: copyToast.left, top: copyToast.top }}
        >
          Context copied
        </div>
      ) : null}
      {/* Radix context menu for line number gutter right-click */}
      <DropdownMenu open={gutterMenuOpen} onOpenChange={setGutterMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: gutterMenuPoint.x, top: gutterMenuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={0} align="start">
          <DropdownMenuItem
            onSelect={() => {
              window.api.ui.writeClipboardText(`${filePath}#L${gutterMenuLine}`)
            }}
          >
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy Path to Line
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              window.api.ui.writeClipboardText(`${relativePath}#L${gutterMenuLine}`)
            }}
          >
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy Rel. Path to Line
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={async () => {
              // Derive worktree root from the absolute and relative paths
              const worktreePath = filePath.slice(0, -(relativePath.length + 1))
              const url = await window.api.git.remoteFileUrl({
                worktreePath,
                relativePath,
                line: gutterMenuLine
              })
              if (url) {
                window.api.ui.writeClipboardText(url)
              }
            }}
          >
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
            Copy Remote URL
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Shared reveal logic used by both onMount and useEffect */
function performReveal(
  ed: editor.IStandaloneCodeEditor,
  line: number,
  column: number,
  matchLength: number
): void {
  const model = ed.getModel()
  const maxLine = model?.getLineCount() ?? Infinity

  // Clamp line to valid range
  const safeLine = Math.min(Math.max(1, line), maxLine)
  const lineLength = model?.getLineMaxColumn(safeLine) ?? Infinity
  const safeCol = Math.min(Math.max(1, column), lineLength)

  ed.setPosition({ lineNumber: safeLine, column: safeCol })
  ed.revealLineInCenter(safeLine)

  // Highlight the match if we have length info
  if (matchLength > 0) {
    const endCol = Math.min(safeCol + matchLength, lineLength)
    ed.setSelection({
      startLineNumber: safeLine,
      startColumn: safeCol,
      endLineNumber: safeLine,
      endColumn: endCol
    })
  }

  ed.focus()
}
