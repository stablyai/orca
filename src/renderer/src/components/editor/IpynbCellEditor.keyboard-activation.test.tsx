// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpynbCellSource } from './IpynbCellEditor'
import type { IpynbCell } from './ipynb-parse'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: { settings: undefined; editorFontZoomLevel: number }) => unknown
  ) => selector({ settings: undefined, editorFontZoomLevel: 0 })
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))
vi.mock('@/lib/monaco-setup', () => ({ monaco: {} }))
vi.mock('./MonacoCodeExcerpt', () => ({ useMonacoColorizedLines: () => [] }))
vi.mock('./MarkdownPreviewBody', () => ({
  MarkdownPreviewBody: ({ content }: { content: string }) => <p>{content}</p>
}))
vi.mock('./editor-shortcuts', () => ({ installMonacoEditorFindShortcut: () => () => {} }))

afterEach(cleanup)

/** Renders an inactive cell of the given kind and returns its activation spy. */
function renderCell(kind: 'code' | 'markdown'): { onActivate: ReturnType<typeof vi.fn> } {
  const onActivate = vi.fn()
  const cell: IpynbCell = {
    id: 'cell-1',
    kind,
    language: 'python',
    source: 'print(1)',
    executionCount: null,
    outputs: []
  }
  render(
    <IpynbCellSource
      cell={cell}
      source="print(1)"
      active={false}
      onActivate={onActivate}
      onDeactivate={vi.fn()}
      onChange={vi.fn()}
    />
  )
  return { onActivate }
}

describe('IpynbCellSource keyboard activation', () => {
  it.each(['code', 'markdown'] as const)('opens an idle %s cell with Space', (kind) => {
    const { onActivate } = renderCell(kind)
    const cell = screen.getByRole('button')

    const notPrevented = fireEvent.keyDown(cell, { key: ' ' })

    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(notPrevented).toBe(false)
  })

  it.each(['code', 'markdown'] as const)('still opens an idle %s cell with Enter', (kind) => {
    const { onActivate } = renderCell(kind)

    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' })

    expect(onActivate).toHaveBeenCalledTimes(1)
  })
})
