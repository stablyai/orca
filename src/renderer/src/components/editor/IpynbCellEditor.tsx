import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { Components } from 'react-markdown'
import { MarkdownPreviewBody } from './MarkdownPreviewBody'
import { monaco } from '@/lib/monaco-setup'
import { computeEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'
import { resolveDocumentTheme } from '@/lib/document-theme'
import { useAppStore } from '@/store'
import { installEditorSaveShortcut, installMonacoEditorFindShortcut } from './editor-shortcuts'
import { getIpynbCodeCellEditorHeight, getIpynbCodeCellPreviewLines } from './ipynb-code-cell-lines'
import type { IpynbCell } from './ipynb-parse'
import MonacoCodeExcerpt from './MonacoCodeExcerpt'

// Shared frozen instance: react-markdown treats it as read-only config.
const EMPTY_MARKDOWN_COMPONENTS: Components = Object.freeze({})

export function IpynbMarkdownCell({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="markdown-preview-body px-4 py-3 text-sm">
      <MarkdownPreviewBody content={source || '\u00a0'} components={EMPTY_MARKDOWN_COMPONENTS} />
    </div>
  )
}

export function IpynbMarkdownCellEditor({
  source,
  active,
  onActivate,
  onChange
}: {
  source: string
  active: boolean
  onActivate: () => void
  onChange: (source: string) => void
}): React.JSX.Element {
  if (active) {
    return (
      <div data-ipynb-cell-editor="true" className="grid gap-0 lg:grid-cols-2">
        <IpynbEditableTextCell source={source} onChange={onChange} />
        <div className="border-t border-border/50 lg:border-l lg:border-t-0">
          <IpynbMarkdownCell source={source} />
        </div>
      </div>
    )
  }
  return (
    <div className="block w-full cursor-text text-left" onDoubleClick={onActivate}>
      <IpynbMarkdownCell source={source} />
    </div>
  )
}

export function IpynbRawCell({ source }: { source: string }): React.JSX.Element {
  return (
    <pre className="overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5 text-foreground scrollbar-editor">
      {source || '\u00a0'}
    </pre>
  )
}

export function IpynbEditableTextCell({
  source,
  onChange
}: {
  source: string
  onChange: (source: string) => void
}): React.JSX.Element {
  return (
    <textarea
      value={source}
      onChange={(event) => onChange(event.target.value)}
      className="block min-h-24 w-full resize-y border-0 bg-background px-4 py-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

function IpynbCodeCellEditor({
  cell,
  source,
  active,
  onActivate,
  onDeactivate,
  onChange,
  onSaveRequest
}: {
  cell: IpynbCell
  source: string
  active: boolean
  onActivate?: () => void
  onDeactivate: () => void
  onChange: (source: string) => void
  onSaveRequest: () => Promise<void>
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const onDeactivateRef = useRef(onDeactivate)
  const onSaveRequestRef = useRef(onSaveRequest)
  useLayoutEffect(() => {
    onDeactivateRef.current = onDeactivate
    onSaveRequestRef.current = onSaveRequest
  }, [onDeactivate, onSaveRequest])
  const fontSize = computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel)
  const editorHeight = getIpynbCodeCellEditorHeight(source, fontSize)
  const isDark = resolveDocumentTheme(settings?.theme ?? 'system')
  const lines = useMemo(() => getIpynbCodeCellPreviewLines(source), [source])
  const handleMount: OnMount = useCallback((editorInstance, monacoInstance) => {
    editorInstance.focus()
    const cleanupSaveShortcut = installEditorSaveShortcut(
      editorInstance.getContainerDomNode(),
      () => {
        void onSaveRequestRef.current()
      }
    )
    const cleanupFindShortcut = installMonacoEditorFindShortcut(editorInstance)
    const blurSub = editorInstance.onDidBlurEditorWidget(() => {
      onDeactivateRef.current()
    })
    editorInstance.onDidDispose(() => {
      cleanupSaveShortcut()
      cleanupFindShortcut()
      blurSub.dispose()
    })
    editorInstance.addCommand(monacoInstance.KeyCode.Escape, () => {
      onDeactivateRef.current()
    })
  }, [])

  useEffect(() => {
    monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs')
  }, [isDark])

  if (!active) {
    return (
      <div
        role={onActivate ? 'button' : undefined}
        tabIndex={onActivate ? 0 : undefined}
        className={`block w-full bg-editor-surface text-left ${onActivate ? 'cursor-text' : ''}`}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onActivate?.()
          }
        }}
      >
        <MonacoCodeExcerpt
          lines={lines}
          firstLineNumber={1}
          highlightedStartLine={-1}
          highlightedEndLine={-1}
          language={cell.language}
        />
      </div>
    )
  }

  return (
    <div className="bg-editor-surface focus-within:ring-1 focus-within:ring-ring">
      <Editor
        height={editorHeight}
        defaultLanguage={cell.language}
        language={cell.language}
        theme={isDark ? 'vs-dark' : 'vs'}
        value={source}
        onMount={handleMount}
        onChange={(value) => onChange(value ?? '')}
        options={{
          automaticLayout: true,
          fontFamily: resolveEditorFontFamily(settings),
          fontSize,
          glyphMargin: false,
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          overviewRulerLanes: 0,
          renderLineHighlight: 'none',
          scrollBeyondLastLine: false,
          wordWrap: 'off'
        }}
      />
    </div>
  )
}

export const IpynbCodeCell = memo(IpynbCodeCellEditor)
