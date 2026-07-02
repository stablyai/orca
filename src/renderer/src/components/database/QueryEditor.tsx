import React, { useCallback, useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import '@/lib/monaco-setup'
import { ensureSqlLanguageRegistered } from '@/lib/monaco-sql-language'
import { useAppStore } from '@/store'

type QueryEditorProps = {
  value: string
  onChange: (value: string) => void
  onRunShortcut: () => void
}

// Monaco SQL editor. Cmd/Ctrl+Enter runs — KeyMod.CtrlCmd is platform-aware
// (Cmd on macOS, Ctrl on Linux/Windows), satisfying the cross-platform rule.
export function QueryEditor({ value, onChange, onRunShortcut }: QueryEditorProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  // Keep the latest run handler without rebinding the Monaco command.
  const runRef = useRef(onRunShortcut)
  runRef.current = onRunShortcut

  useEffect(() => {
    void ensureSqlLanguageRegistered()
  }, [])

  const handleMount: OnMount = useCallback((editor, monaco) => {
    void ensureSqlLanguageRegistered()
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current())
  }, [])

  return (
    <Editor
      height="100%"
      language="sql"
      value={value}
      theme={isDark ? 'vs-dark' : 'vs'}
      onChange={(next) => onChange(next ?? '')}
      onMount={handleMount}
      options={{
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        fontFamily: settings?.terminalFontFamily || 'monospace',
        lineNumbers: 'on',
        automaticLayout: true,
        tabSize: 2,
        wordWrap: 'on',
        padding: { top: 8 }
      }}
    />
  )
}
