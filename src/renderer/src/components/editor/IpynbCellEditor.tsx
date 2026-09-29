import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import { computeEditorFontSize, resolveEditorFontStack } from '@/lib/editor-font-zoom'
import { useAppStore } from '@/store'
import { installMonacoEditorFindShortcut } from './editor-shortcuts'
import {
  IPYNB_CODE_CELL_PREVIEW_MAX_LINES,
  getIpynbCodeCellPreviewLines
} from './ipynb-code-cell-lines'
import type { IpynbCell } from './ipynb-parse'
import { MarkdownPreviewBody } from './MarkdownPreviewBody'
import { useMonacoColorizedLines } from './MonacoCodeExcerpt'
import { useDocumentDarkTheme } from './use-document-dark-theme'
import { useMonacoDarkThemeName } from '@/lib/monaco-editor-theme'

const NO_MARKDOWN_COMPONENTS: Components = {}
// Box metrics the preview and the live editor share, so activating a cell never shifts it.
const CODE_LAYOUT = { lineHeight: 20, paddingY: 4, paddingX: 12 } as const
// Fixed rows keep colorized blank lines one line tall; preflight gives <code> its own font.
const CODE_ROW_STYLE = {
  height: CODE_LAYOUT.lineHeight,
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
  cell: IpynbCell
  source: string
  active: boolean
  onActivate: () => void
  onDeactivate: () => void
  onChange: (source: string) => void
}

type ClientPoint = { x: number; y: number }

/** Rendered cell source (markdown document or colorized code) that swaps to Monaco while active. */
export function IpynbCellSource(props: IpynbCellSourceProps): React.JSX.Element {
  const { cell, source, active, onActivate } = props
  // Where the activating press landed; Monaco opens its caret there, or at the start when null.
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
    <div className="ipynb-code-surface overflow-hidden rounded-md border border-border bg-muted/60 focus-within:border-ring">
      {active ? (
        <IpynbSourceEditor {...props} pressedAt={pressedAt} />
      ) : (
        <div
          role="button"
          tabIndex={0}
          className="cursor-text outline-none"
          // Why: activating on press (not click) keeps the target stable while the previously active cell collapses.
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
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const lines = useMemo(() => getIpynbCodeCellPreviewLines(source), [source])
  const htmlLines = useMonacoColorizedLines(lines, language)
  return (
    <div
      className="overflow-x-auto text-foreground"
      style={{
        fontFamily: resolveEditorFontStack(settings),
        fontSize: computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel),
        lineHeight: `${CODE_LAYOUT.lineHeight}px`,
        paddingBlock: CODE_LAYOUT.paddingY,
        // Monaco renders code without the app's body tracking.
        letterSpacing: 0
      }}
    >
      {lines.map((line, index) => (
        <code
          key={index}
          className="block whitespace-pre"
          style={CODE_ROW_STYLE}
          // Plain text shows until Monaco's async colorizer fills in token HTML.
          dangerouslySetInnerHTML={{ __html: htmlLines[index] || escapeHtml(line) }}
        />
      ))}
    </div>
  )
}

function IpynbSourceEditor({
  cell,
  source,
  pressedAt,
  onDeactivate,
  onChange
}: IpynbCellSourceProps & { pressedAt: ClientPoint | null }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const isDark = useDocumentDarkTheme()
  const monacoDarkTheme = useMonacoDarkThemeName()
  const fontFamily = resolveEditorFontStack(settings)
  const fontSize = computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel)
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  useLayoutEffect(() => {
    monaco.editor.setTheme(isDark ? monacoDarkTheme : 'vs')
  }, [isDark, monacoDarkTheme])

  useLayoutEffect(() => {
    editorRef.current?.updateOptions({ fontFamily, fontSize })
  }, [fontFamily, fontSize])

  // Why: created synchronously before paint (not via @monaco-editor/react's async loader), so the
  // swap from the preview never shows a placeholder, an unlaid-out editor or a guessed caret.
  // Mount-once: the props it reads cannot change while the cell is being edited.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const { lineHeight, paddingX, paddingY } = CODE_LAYOUT
    const model = monaco.editor.createModel(source, cell.language)
    const editorInstance = monaco.editor.create(container, {
      model,
      automaticLayout: true,
      fontFamily,
      fontSize,
      // Why: same box as the preview it replaces. No gutter, so the decorations lane is the inset.
      lineHeight,
      padding: { top: paddingY, bottom: paddingY },
      lineNumbers: 'off',
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: paddingX,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      renderLineHighlight: 'none',
      // The preview has no indent guides; matching it keeps the swap invisible.
      guides: { indentation: false },
      // Clicking (word highlight) or double-clicking (selection highlight) a word should not light
      // up its other occurrences like a search.
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      scrollBeyondLastLine: false,
      // Why: an auto-sized cell must let wheel events scroll the notebook, not trap them.
      scrollbar: { alwaysConsumeMouseWheel: false },
      wordWrap: cell.kind === 'code' ? 'off' : 'on'
    })
    editorRef.current = editorInstance
    const maxHeight = IPYNB_CODE_CELL_PREVIEW_MAX_LINES * lineHeight
    const fitHeight = (): void => {
      container.style.height = `${Math.min(editorInstance.getContentHeight(), maxHeight)}px`
      editorInstance.layout()
    }
    fitHeight()
    editorInstance.onDidContentSizeChange(fitHeight)
    // Why: restoring a view state marks the visible lines stable, so Monaco tokenizes them now
    // rather than 50ms later; without it the first frame paints uncoloured text.
    editorInstance.restoreViewState(editorInstance.saveViewState())
    // Monaco hit-tests the press against its own lines, so the caret lands where the user pressed.
    const target = pressedAt && editorInstance.getTargetAtClientPoint(pressedAt.x, pressedAt.y)
    if (target?.position) {
      editorInstance.setPosition(target.position)
    }
    editorInstance.focus()
    model.onDidChangeContent(() => onChange(model.getValue()))
    editorInstance.onDidBlurEditorWidget(onDeactivate)
    // Escape closes an open widget first; only a bare Escape leaves the cell.
    editorInstance.addCommand(
      monaco.KeyCode.Escape,
      onDeactivate,
      '!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible'
    )
    const cleanupFindShortcut = installMonacoEditorFindShortcut(editorInstance)
    return () => {
      cleanupFindShortcut()
      editorInstance.dispose()
      model.dispose()
      editorRef.current = null
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-once; see the Why above.
  }, [])

  return <div ref={containerRef} />
}
