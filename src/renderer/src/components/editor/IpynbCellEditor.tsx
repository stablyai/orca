import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import {
  EDITOR_TYPOGRAPHY_SURFACE_CLASS,
  editorTypographyTextStyle,
  monacoTypographyOptions
} from '@/lib/editor-typography'
import { useEditorTypography } from '@/hooks/use-editor-typography'
import { cn } from '@/lib/utils'
import { installMonacoEditorFindShortcut } from './editor-shortcuts'
import { syncContentUpdate } from './monaco-content-sync'
import {
  IPYNB_CODE_CELL_PREVIEW_MAX_LINES,
  getIpynbCodeCellPreviewLines
} from './ipynb-code-cell-lines'
import type { IpynbCell } from './ipynb-parse'
import { MarkdownPreviewBody } from './MarkdownPreviewBody'
import { useMonacoColorizedLines } from './MonacoCodeExcerpt'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { useMonacoTheme } from '@/hooks/use-monaco-theme'

const NO_MARKDOWN_COMPONENTS: Components = {}
// Share preview/editor box metrics to avoid shifts on activation.
const CODE_LAYOUT = { lineHeight: 20, paddingY: 4, paddingX: 12 } as const
// Fixed rows keep colorized blank lines one line tall; preflight gives <code> its own font.
const CODE_ROW_STYLE = {
  paddingInline: CODE_LAYOUT.paddingX,
  fontFamily: 'inherit'
} as const

export function IpynbMarkdownCell({ source }: { source: string }): React.JSX.Element {
  const isDark = useDocumentDarkTheme()
  return (
    <div className={isDark ? 'markdown-dark' : 'markdown-light'}>
      <div className="markdown-body">
        <MarkdownPreviewBody content={source} components={NO_MARKDOWN_COMPONENTS} />
      </div>
    </div>
  )
}

type IpynbCellSourceProps = {
  /** Null for cells without a stable id, whose position-based key can move to another cell. */
  modelKey: string | null
  cell: IpynbCell
  source: string
  active: boolean
  onActivate: () => void
  onDeactivate: () => void
  onChange: (source: string) => void
}

type ClientPoint = { x: number; y: number }

export function IpynbCellSource(props: IpynbCellSourceProps): React.JSX.Element {
  const { cell, source, active, onActivate } = props
  const [pressedAt, setPressedAt] = useState<ClientPoint | null>(null)
  const activate = (point: ClientPoint | null): void => {
    setPressedAt(point)
    onActivate()
  }
  const activateOnEnter = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault()
      activate(null)
    }
  }

  if (!active && cell.kind === 'markdown') {
    return (
      <div
        role="button"
        tabIndex={0}
        className="min-h-8 cursor-text rounded-md px-3 py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onDoubleClick={() => activate(null)}
        onKeyDown={activateOnEnter}
      >
        <IpynbMarkdownCell source={source} />
      </div>
    )
  }

  return (
    <div className="ipynb-code-surface code-editor-colors overflow-hidden rounded-md border border-border bg-muted/60 focus-within:border-ring">
      {active ? (
        <IpynbSourceEditor {...props} pressedAt={pressedAt} />
      ) : (
        <div
          role="button"
          tabIndex={0}
          className="cursor-text outline-none"
          // Activate on press before the previous cell collapses and moves the click target.
          onMouseDown={(event) => {
            if (event.button === 0) {
              event.preventDefault()
              activate({ x: event.clientX, y: event.clientY })
            }
          }}
          onKeyDown={activateOnEnter}
        >
          <IpynbCodePreview source={source} language={cell.language} />
        </div>
      )}
    </div>
  )
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function IpynbCodePreview({
  source,
  language
}: {
  source: string
  language: string
}): React.JSX.Element {
  const typography = useEditorTypography()
  const lineHeight = typography.lineHeight || CODE_LAYOUT.lineHeight
  const lines = useMemo(() => getIpynbCodeCellPreviewLines(source), [source])
  const htmlLines = useMonacoColorizedLines(lines, language)
  return (
    <div
      className={cn('overflow-x-auto text-foreground', EDITOR_TYPOGRAPHY_SURFACE_CLASS)}
      style={{
        ...editorTypographyTextStyle(typography),
        lineHeight: `${lineHeight}px`,
        paddingBlock: CODE_LAYOUT.paddingY,
        // Monaco renders code without the app's body tracking.
        letterSpacing: 0
      }}
    >
      {lines.map((line, index) => (
        <code
          key={index}
          className="block whitespace-pre"
          style={{ ...CODE_ROW_STYLE, height: lineHeight }}
          dangerouslySetInnerHTML={{ __html: htmlLines[index] || escapeHtml(line) }}
        />
      ))}
    </div>
  )
}

function IpynbSourceEditor({
  modelKey,
  cell,
  source,
  pressedAt,
  onDeactivate,
  onChange
}: IpynbCellSourceProps & { pressedAt: ClientPoint | null }): React.JSX.Element {
  const monacoTheme = useMonacoTheme()
  const typography = useEditorTypography()
  // Monaco gets the CSS stack so cells match their DOM previews.
  const typographyOptions = useMemo(
    () => ({
      ...monacoTypographyOptions(typography),
      fontFamily: typography.cssFontFamily,
      lineHeight: typography.lineHeight || CODE_LAYOUT.lineHeight
    }),
    [typography]
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const callbacksRef = useRef({ onChange, onDeactivate })
  const syncingSourceRef = useRef(false)
  const fitHeightRef = useRef<(() => void) | null>(null)
  // The mount-once fit closure must cap height with the live line height, which typography can change.
  const lineHeightRef = useRef(typographyOptions.lineHeight)

  useLayoutEffect(() => {
    callbacksRef.current = { onChange, onDeactivate }
  }, [onChange, onDeactivate])

  useLayoutEffect(() => {
    monaco.editor.setTheme(monacoTheme)
  }, [monacoTheme])

  // Create before paint to avoid placeholders and guessed caret geometry; retain the model and undo history across external reloads.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const { paddingX, paddingY } = CODE_LAYOUT
    // Monaco restores undo for disposed models with this scheme; no other Monaco feature special-cases it.
    const uri =
      modelKey === null
        ? null
        : monaco.Uri.from({ scheme: 'vscode-userdata', path: `/${modelKey}` })
    const model = monaco.editor.createModel(
      source,
      cell.language,
      uri && !monaco.editor.getModel(uri) ? uri : undefined
    )
    const editorInstance = monaco.editor.create(container, {
      dropIntoEditor: { enabled: false },
      model,
      automaticLayout: true,
      // Match preview geometry; the decorations lane supplies the inset without a gutter.
      ...typographyOptions,
      padding: { top: paddingY, bottom: paddingY },
      lineNumbers: 'off',
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: paddingX,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      renderLineHighlight: 'none',
      guides: { indentation: false },
      // Do not highlight other word occurrences when clicking or selecting cell text.
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      scrollBeyondLastLine: false,
      // Auto-sized cells must yield wheel scrolling to the notebook.
      scrollbar: { alwaysConsumeMouseWheel: false },
      wordWrap: cell.kind === 'code' ? 'off' : 'on'
    })
    editorRef.current = editorInstance
    const fitHeight = (): void => {
      const maxHeight = IPYNB_CODE_CELL_PREVIEW_MAX_LINES * lineHeightRef.current
      container.style.height = `${Math.min(editorInstance.getContentHeight(), maxHeight)}px`
      editorInstance.layout()
    }
    fitHeightRef.current = fitHeight
    fitHeight()
    editorInstance.onDidContentSizeChange(fitHeight)
    // Restoring view state marks visible lines stable and forces tokenization before the first paint.
    editorInstance.restoreViewState(editorInstance.saveViewState())
    const target = pressedAt && editorInstance.getTargetAtClientPoint(pressedAt.x, pressedAt.y)
    if (target?.position) {
      editorInstance.setPosition(target.position)
    }
    editorInstance.focus()
    model.onDidChangeContent(() => {
      if (!syncingSourceRef.current) {
        callbacksRef.current.onChange(model.getValue())
      }
    })
    editorInstance.onDidBlurEditorWidget(() => callbacksRef.current.onDeactivate())
    // Escape closes an open widget first; only a bare Escape leaves the cell.
    editorInstance.addCommand(
      monaco.KeyCode.Escape,
      () => callbacksRef.current.onDeactivate(),
      '!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible'
    )
    const cleanupFindShortcut = installMonacoEditorFindShortcut(editorInstance)
    return () => {
      cleanupFindShortcut()
      editorInstance.dispose()
      model.dispose()
      editorRef.current = null
      fitHeightRef.current = null
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-once; see the Why above.
  }, [])

  useLayoutEffect(() => {
    const editorInstance = editorRef.current
    const model = editorInstance?.getModel()
    if (!editorInstance || !model) {
      return
    }
    if (model.getLanguageId() !== cell.language) {
      monaco.editor.setModelLanguage(model, cell.language)
    }
    lineHeightRef.current = typographyOptions.lineHeight
    editorInstance.updateOptions({
      ...typographyOptions,
      wordWrap: cell.kind === 'code' ? 'off' : 'on'
    })
    syncingSourceRef.current = true
    try {
      syncContentUpdate(editorInstance, source)
    } finally {
      syncingSourceRef.current = false
    }
    fitHeightRef.current?.()
  }, [source, cell.language, cell.kind, typographyOptions])

  return <div ref={containerRef} />
}
