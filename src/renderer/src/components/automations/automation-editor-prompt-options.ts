import type { editor } from 'monaco-editor'
import { monacoFindOptions } from '@/components/editor/monaco-find-options'

export function buildAutomationPromptEditorOptions(args: {
  ariaLabel: string
  fontFamily: string
  fontSize: number
  placeholder: string
}): editor.IStandaloneEditorConstructionOptions {
  return {
    ariaLabel: args.ariaLabel,
    automaticLayout: true,
    contextmenu: true,
    folding: false,
    fontFamily: args.fontFamily,
    fontSize: args.fontSize,
    find: monacoFindOptions,
    glyphMargin: false,
    hover: { enabled: false },
    lineDecorationsWidth: 16,
    lineNumbers: 'off',
    lineNumbersMinChars: 0,
    links: false,
    minimap: { enabled: false },
    overviewRulerBorder: false,
    overviewRulerLanes: 0,
    padding: { top: 12, bottom: 12 },
    placeholder: args.placeholder,
    parameterHints: { enabled: false },
    quickSuggestions: false,
    renderLineHighlight: 'none',
    scrollBeyondLastLine: false,
    scrollbar: {
      horizontalScrollbarSize: 8,
      verticalScrollbarSize: 8
    },
    stickyScroll: { enabled: false },
    suggestOnTriggerCharacters: false,
    tabSize: 2,
    wordBasedSuggestions: 'off',
    wordWrap: 'on'
  }
}
