// @vitest-environment happy-dom
import type { editor } from 'monaco-editor'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpynbCellSource } from './IpynbCellEditor'
import { IPYNB_CODE_CELL_PREVIEW_MAX_LINES } from './ipynb-code-cell-lines'
import type { IpynbCell } from './ipynb-parse'

type StoreState = { settings: Record<string, unknown>; editorFontZoomLevel: number }
type WidgetState = {
  createOptions: editor.IStandaloneEditorConstructionOptions | null
  container: HTMLElement | null
  updateOptions: ReturnType<typeof vi.fn<(options: editor.IEditorOptions) => void>>
}

const storeState = vi.hoisted((): StoreState => ({ settings: {}, editorFontZoomLevel: 0 }))
const widget = vi.hoisted((): WidgetState => ({
  createOptions: null,
  container: null,
  updateOptions: vi.fn<(options: editor.IEditorOptions) => void>()
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(storeState)
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))
vi.mock('./MonacoCodeExcerpt', () => ({ useMonacoColorizedLines: () => [] }))
vi.mock('./editor-shortcuts', () => ({ installMonacoEditorFindShortcut: () => () => {} }))
vi.mock('@/lib/monaco-setup', async () => {
  const actual = await import('monaco-editor/esm/vs/editor/editor.api.js')
  actual.languages.register({ id: 'python' })
  return {
    monaco: {
      ...actual,
      editor: {
        ...actual.editor,
        setTheme: vi.fn(),
        create: (
          container: HTMLElement,
          options: editor.IStandaloneEditorConstructionOptions & { model: editor.ITextModel }
        ) => {
          widget.container = container
          widget.createOptions = options
          return {
            getModel: () => options.model,
            // Taller than the cap, so the fitted height is exactly the line-count cap.
            getContentHeight: () => 1_000_000,
            layout: vi.fn(),
            onDidContentSizeChange: () => ({ dispose: vi.fn() }),
            restoreViewState: vi.fn(),
            saveViewState: () => null,
            getTargetAtClientPoint: () => null,
            setPosition: vi.fn(),
            focus: vi.fn(),
            onDidBlurEditorWidget: () => ({ dispose: vi.fn() }),
            addCommand: vi.fn(),
            updateOptions: widget.updateOptions,
            pushUndoStop: () => true,
            dispose: vi.fn()
          }
        }
      }
    }
  }
})

const CELL: IpynbCell = {
  id: 'cell-1',
  kind: 'code',
  language: 'python',
  source: 'first = 1\nsecond = 2',
  executionCount: 1,
  outputs: []
}

function renderCell(active: boolean): ReturnType<typeof render> {
  return render(
    <IpynbCellSource
      cell={CELL}
      source={CELL.source}
      active={active}
      onActivate={vi.fn()}
      onDeactivate={vi.fn()}
      onChange={vi.fn()}
    />
  )
}

function previewRowHeights(): string[] {
  return Array.from(screen.getByRole('button').querySelectorAll('code')).map(
    (row) => row.style.height
  )
}

afterEach(() => {
  cleanup()
  widget.updateOptions.mockClear()
  storeState.settings = {}
  storeState.editorFontZoomLevel = 0
})

describe('notebook code cell line height', () => {
  it('keeps 20px rows at the default size', () => {
    storeState.settings = { terminalFontSize: 14 }
    renderCell(false)
    expect(previewRowHeights()).toEqual(['20px', '20px'])
  })

  it('grows preview rows with the editor font size so lines cannot overlap', () => {
    storeState.settings = { terminalFontSize: 14, editorFontSize: 24 }
    renderCell(false)
    expect(previewRowHeights()).toEqual(['35px', '35px'])
  })

  it('gives the live editor the same rows as the preview it replaces', () => {
    storeState.settings = { terminalFontSize: 14, editorFontSize: 24 }
    renderCell(true)
    expect(widget.createOptions).toMatchObject({ fontSize: 24, lineHeight: 35 })
    expect(widget.container?.style.height).toBe(`${IPYNB_CODE_CELL_PREVIEW_MAX_LINES * 35}px`)
  })

  it('re-caps an open cell when editor zoom changes its font size', () => {
    storeState.settings = { terminalFontSize: 14, editorFontSize: 24 }
    const { rerender } = renderCell(true)
    storeState.editorFontZoomLevel = 8
    rerender(
      <IpynbCellSource
        cell={CELL}
        source={CELL.source}
        active
        onActivate={vi.fn()}
        onDeactivate={vi.fn()}
        onChange={vi.fn()}
      />
    )
    expect(widget.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ fontSize: 32, lineHeight: 46 })
    )
    expect(widget.container?.style.height).toBe(`${IPYNB_CODE_CELL_PREVIEW_MAX_LINES * 46}px`)
  })
})
