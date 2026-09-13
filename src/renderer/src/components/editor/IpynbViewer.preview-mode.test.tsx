// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: {}, editorFontZoomLevel: 0 })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutKeyDetails: () => undefined }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./useIpynbScrollRestoration', () => ({ useIpynbScrollRestoration: () => {} }))
vi.mock('./useIpynbDocumentEditing', () => ({
  getIpynbCellKey: (_cell: unknown, index: number) => `cell-${index}`,
  hasIpynbSourceDraft: () => false,
  useIpynbDocumentEditing: () => ({
    rootRef: null,
    setRootRef: () => {},
    sourceDrafts: {},
    flushSourceDrafts: () => '{}',
    applyContent: () => {},
    updateCellSource: () => {},
    updateCellKind: () => {},
    insertCell: () => {},
    moveCell: () => {},
    deleteCell: () => {}
  })
}))
vi.mock('./useIpynbCellExecution', () => ({
  useIpynbCellExecution: () => ({
    runError: null,
    runningCellIndex: null,
    pendingRunCellIndex: null,
    runCell: () => {},
    cancelPendingRun: () => {},
    confirmPendingRun: () => {}
  })
}))
vi.mock('./IpynbCellEditor', () => ({
  IpynbCodeCell: () => <div data-testid="code-cell" />,
  IpynbEditableTextCell: () => <div data-testid="raw-editor" />,
  IpynbMarkdownCell: () => <div data-testid="markdown-preview" />,
  IpynbMarkdownCellEditor: () => <div data-testid="markdown-editor" />,
  IpynbRawCell: () => <div data-testid="raw-preview" />
}))
vi.mock('./IpynbCellOutputs', () => ({ IpynbCellOutputs: () => null }))
vi.mock('./editor-shortcuts', () => ({ editorShortcutMatches: () => true }))
vi.mock('./IpynbCellToolbar', () => ({
  IpynbCellToolbar: () => <div data-testid="cell-toolbar" />,
  IpynbToolbarButton: ({
    label,
    onClick,
    children
  }: {
    label: string
    onClick: () => void
    children: React.ReactNode
  }) => (
    <button aria-label={label} onClick={onClick}>
      {children}
    </button>
  )
}))

import IpynbViewer from './IpynbViewer'

const CONTENT = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: 'python' } },
  cells: [{ id: 'intro', cell_type: 'markdown', metadata: {}, source: ['# Report'] }]
})

afterEach(() => cleanup())

describe('IpynbViewer preview mode', () => {
  it('opens as a clean rendered notebook and reveals editing controls on demand', () => {
    render(
      <IpynbViewer
        content={CONTENT}
        fileId="notebook.ipynb"
        filePath="/repo/notebook.ipynb"
        worktreeId="wt-1"
        scrollCacheKey="notebook"
        onContentChange={() => {}}
        onDirtyStateHint={() => {}}
        onSave={async () => true}
      />
    )

    expect(screen.getByTestId('markdown-preview')).toBeTruthy()
    expect(screen.queryByTestId('markdown-editor')).toBeNull()
    expect(screen.queryByTestId('cell-toolbar')).toBeNull()
    expect(screen.queryByLabelText('Save notebook')).toBeNull()
    expect(screen.getByTestId('ipynb-cell-header')).toBeTruthy()
    expect(screen.getByText('#1')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Edit'))

    expect(screen.getByTestId('markdown-editor')).toBeTruthy()
    expect(screen.getByTestId('cell-toolbar')).toBeTruthy()
    expect(screen.getByTestId('ipynb-cell-header')).toBeTruthy()
    expect(screen.getByLabelText('Save notebook')).toBeTruthy()
    expect(screen.getByLabelText('Preview')).toBeTruthy()
  })

  it('shows the execution count and cell number for code cells in preview', () => {
    const codeContent = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: [
        {
          id: 'code-1',
          cell_type: 'code',
          metadata: {},
          execution_count: 3,
          source: ['print(1)'],
          outputs: []
        }
      ]
    })
    render(
      <IpynbViewer
        content={codeContent}
        fileId="notebook.ipynb"
        filePath="/repo/notebook.ipynb"
        worktreeId="wt-1"
        scrollCacheKey="notebook-code"
        onContentChange={() => {}}
        onDirtyStateHint={() => {}}
        onSave={async () => true}
      />
    )

    expect(screen.getByTestId('ipynb-cell-header')).toBeTruthy()
    expect(screen.getByText('In [3]:')).toBeTruthy()
    expect(screen.getByText('#1')).toBeTruthy()
    expect(screen.queryByTestId('cell-toolbar')).toBeNull()
  })

  it('ignores the save shortcut while in preview and honors it once editing', () => {
    const onSave = vi.fn(async () => true)
    const { container } = render(
      <IpynbViewer
        content={CONTENT}
        fileId="notebook.ipynb"
        filePath="/repo/notebook.ipynb"
        worktreeId="wt-1"
        scrollCacheKey="notebook-save-guard"
        onContentChange={() => {}}
        onDirtyStateHint={() => {}}
        onSave={onSave}
      />
    )
    const root = container.firstElementChild as Element
    fireEvent.keyDown(root, { key: 's', ctrlKey: true })
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Edit'))
    fireEvent.keyDown(root, { key: 's', ctrlKey: true })
    expect(onSave).toHaveBeenCalledOnce()
  })
})
