import React, { useRef, useCallback, useEffect } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import '@/lib/monaco-setup'

type MonacoEditorProps = {
  filePath: string
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
  content,
  language,
  onContentChange,
  onSave,
  revealLine,
  revealColumn,
  revealMatchLength
}: MonacoEditorProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const settings = useAppStore((s) => s.settings)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const handleMount: OnMount = useCallback(
    (editorInstance, monaco) => {
      editorRef.current = editorInstance

      // Add Cmd+S save keybinding
      editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        const value = editorInstance.getValue()
        onSave(value)
      })

      // If there's a pending reveal at mount time, execute it now
      const reveal = useAppStore.getState().pendingEditorReveal
      if (reveal) {
        performReveal(editorInstance, reveal.line, reveal.column, reveal.matchLength)
        useAppStore.getState().setPendingEditorReveal(null)
      } else {
        editorInstance.focus()
      }
    },
    [onSave]
  )

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        onContentChange(value)
      }
    },
    [onContentChange]
  )

  // Update editor options when settings change
  useEffect(() => {
    if (!editorRef.current || !settings) {
      return
    }
    editorRef.current.updateOptions({
      fontSize: settings.terminalFontSize,
      fontFamily: settings.terminalFontFamily || 'monospace'
    })
  }, [settings])

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
    <Editor
      height="100%"
      language={language}
      value={content}
      theme={isDark ? 'vs-dark' : 'vs'}
      onChange={handleChange}
      onMount={handleMount}
      options={{
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        fontSize: settings?.terminalFontSize ?? 13,
        fontFamily: settings?.terminalFontFamily || 'monospace',
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        automaticLayout: true,
        tabSize: 2,
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'off',
        padding: { top: 8 }
      }}
      path={filePath}
    />
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
