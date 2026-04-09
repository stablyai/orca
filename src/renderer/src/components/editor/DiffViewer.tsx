import React, { useCallback, useLayoutEffect, useRef } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import '@/lib/monaco-setup'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'

type DiffViewerProps = {
  filePath: string
  originalContent: string
  modifiedContent: string
  language: string
  sideBySide: boolean
  editable?: boolean
  onContentChange?: (content: string) => void
  onSave?: (content: string) => void
}

export default function DiffViewer({
  filePath,
  originalContent,
  modifiedContent,
  language,
  sideBySide,
  editable,
  onContentChange,
  onSave
}: DiffViewerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const editorFontSize = computeEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  // Why: The scroll throttle timer must be accessible from useLayoutEffect cleanup
  // so we can cancel any pending write before synchronously snapshotting the final
  // scroll position on unmount.
  const scrollThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep refs to latest callbacks so the mounted editor always calls current versions
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange

  const handleMount: DiffOnMount = useCallback(
    (diffEditor, monaco) => {
      diffEditorRef.current = diffEditor
      // Why: The modified editor controls scroll in both inline and side-by-side
      // modes, so attaching the listener here covers both layouts.
      const modifiedEditor = diffEditor.getModifiedEditor()

      // Throttled scroll save — same pattern as MonacoEditor
      modifiedEditor.onDidScrollChange((e) => {
        if (scrollThrottleTimerRef.current !== null) {
          clearTimeout(scrollThrottleTimerRef.current)
        }
        scrollThrottleTimerRef.current = setTimeout(() => {
          setWithLRU(scrollTopCache, `${filePath}:diff`, e.scrollTop)
          scrollThrottleTimerRef.current = null
        }, 150)
      })

      // Restore scroll position from cache
      const savedScrollTop = scrollTopCache.get(`${filePath}:diff`)
      if (savedScrollTop !== undefined) {
        requestAnimationFrame(() => modifiedEditor.setScrollTop(savedScrollTop))
      }

      if (editable) {
        // Cmd/Ctrl+S to save
        modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current?.(modifiedEditor.getValue())
        })

        // Track changes
        modifiedEditor.onDidChangeModelContent(() => {
          onContentChangeRef.current?.(modifiedEditor.getValue())
        })

        modifiedEditor.focus()
      } else {
        diffEditor.focus()
      }
    },
    [editable, filePath]
  )

  // Snapshot scroll position synchronously on unmount so tab switches always
  // capture the latest value, even if the trailing throttle hasn't fired yet.
  useLayoutEffect(() => {
    return () => {
      if (scrollThrottleTimerRef.current !== null) {
        clearTimeout(scrollThrottleTimerRef.current)
        scrollThrottleTimerRef.current = null
      }
      const de = diffEditorRef.current
      if (de) {
        setWithLRU(scrollTopCache, `${filePath}:diff`, de.getModifiedEditor().getScrollTop())
      }
    }
  }, [filePath])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0">
        <DiffEditor
          height="100%"
          language={language}
          original={originalContent}
          modified={modifiedContent}
          theme={isDark ? 'vs-dark' : 'vs'}
          onMount={handleMount}
          originalModelPath={`diff:original:${filePath}`}
          modifiedModelPath={`diff:modified:${filePath}`}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          options={{
            readOnly: !editable,
            originalEditable: false,
            renderSideBySide: sideBySide,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: editorFontSize,
            fontFamily: settings?.terminalFontFamily || 'monospace',
            lineNumbers: 'on',
            automaticLayout: true,
            renderOverviewRuler: true,
            padding: { top: 0 },
            find: {
              addExtraSpaceOnTop: false,
              autoFindInSelection: 'never',
              seedSearchStringFromSelection: 'never'
            }
          }}
        />
      </div>
    </div>
  )
}
