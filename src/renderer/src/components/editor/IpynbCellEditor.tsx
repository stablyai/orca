import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { computeEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'
import { useMonacoEditorTheme } from './use-monaco-editor-theme'
import { useAppStore } from '@/store'
import { installEditorSaveShortcut, installMonacoEditorFindShortcut } from './editor-shortcuts'
import { getIpynbCodeCellEditorHeight, getIpynbCodeCellPreviewLines } from './ipynb-code-cell-lines'
import type { IpynbCell } from './ipynb-parse'
import MonacoCodeExcerpt from './MonacoCodeExcerpt'

export function IpynbMarkdownCell({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="markdown-preview-body px-4 py-3 text-sm">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}>
        {source || '\u00a0'}
      </Markdown>
    </div>
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

/** Monaco-backed editor for one notebook code cell; mounts only while the cell is active. */
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
  onActivate: () => void
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
  const { theme: monacoTheme } = useMonacoEditorTheme()
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

  if (!active) {
    return (
      <div
        role="button"
        tabIndex={0}
        className="block w-full cursor-text bg-editor-surface text-left"
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onActivate()
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
        theme={monacoTheme}
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
