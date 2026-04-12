import React, { useCallback, useRef } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { useAppStore } from '@/store'
import '@/lib/monaco-setup'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { useContextualCopySetup } from './useContextualCopySetup'

type DiffViewerProps = {
  originalContent: string
  modifiedContent: string
  language: string
  filePath: string
  relativePath: string
  sideBySide: boolean
  editable?: boolean
  onContentChange?: (content: string) => void
  onSave?: (content: string) => void
}

export default function DiffViewer({
  originalContent,
  modifiedContent,
  language,
  filePath,
  relativePath,
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

  // Keep refs to latest callbacks so the mounted editor always calls current versions
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange

  const { setupCopy, toastNode } = useContextualCopySetup()

  const propsRef = useRef({ relativePath, language, onSave })
  propsRef.current = { relativePath, language, onSave }

  const handleMount: DiffOnMount = useCallback(
    (editor, monaco) => {
      const originalEditor = editor.getOriginalEditor()
      const modifiedEditor = editor.getModifiedEditor()

      setupCopy(originalEditor, monaco, filePath, propsRef)
      setupCopy(modifiedEditor, monaco, filePath, propsRef)

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
        editor.focus()
      }
    },
    [editable, setupCopy, filePath]
  )

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
      {toastNode}
    </div>
  )
}
