// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

// Why: stubbing each lazy-imported viewer with a stub keeps the dispatch
// site (the real <DocxViewer>/<XlsxViewer>/<ImageViewer> JSX in EditorContent)
// observable while keeping the test fast and side-effect free.
vi.mock('./DocxViewer', () => ({
  DocxViewer: () => <div data-viewer="docx" data-testid="viewer-docx" />
}))
vi.mock('./XlsxViewer', () => ({
  XlsxViewer: () => <div data-viewer="xlsx" data-testid="viewer-xlsx" />
}))
vi.mock('./ImageViewer', () => ({
  default: () => <div data-viewer="image" data-testid="viewer-image" />
}))
vi.mock('./MonacoEditor', () => ({
  MonacoEditor: () => <div data-viewer="monaco" />
}))
vi.mock('./DiffViewer', () => ({
  DiffViewer: () => <div data-viewer="diff" />
}))
vi.mock('./CombinedDiffViewer', () => ({
  CombinedDiffViewer: () => <div data-viewer="combined-diff" />
}))
vi.mock('./RichMarkdownEditor', () => ({
  RichMarkdownEditor: () => <div data-viewer="rich-md" />
}))
vi.mock('./MarkdownPreview', () => ({
  MarkdownPreview: () => <div data-viewer="md-preview" />
}))
vi.mock('./ImageDiffViewer', () => ({
  ImageDiffViewer: () => <div data-viewer="image-diff" />
}))
vi.mock('./MermaidViewer', () => ({
  MermaidViewer: () => <div data-viewer="mermaid" />
}))
vi.mock('./CsvViewer', () => ({
  CsvViewer: () => <div data-viewer="csv" />
}))
vi.mock('./IpynbViewer', () => ({
  IpynbViewer: () => <div data-viewer="ipynb" />
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        worktreesByRepo: {},
        openFile: vi.fn(),
        openMarkdownPreview: vi.fn(),
        openConflictReviewFile: vi.fn(),
        openConflictReview: vi.fn(),
        closeFile: vi.fn(),
        setRightSidebarTab: vi.fn(),
        setPendingEditorReveal: vi.fn(),
        reloadOpenCheckRunDetailsTab: vi.fn()
      }),
    {
      getState: () => ({
        folderWorkspaces: [],
        projectGroups: [],
        repos: [],
        settings: {},
        worktreesByRepo: {},
        openFile: vi.fn(),
        openMarkdownPreview: vi.fn(),
        openConflictReviewFile: vi.fn(),
        openConflictReview: vi.fn(),
        closeFile: vi.fn(),
        setRightSidebarTab: vi.fn(),
        setPendingEditorReveal: vi.fn(),
        reloadOpenCheckRunDetailsTab: vi.fn()
      })
    }
  )
}))

import { EditorContent, getMarkdownSourceLineOffset } from './EditorContent'

function createOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/notebook.ipynb',
    filePath: '/repo/notebook.ipynb',
    relativePath: 'notebook.ipynb',
    worktreeId: 'repo::/repo',
    language: 'notebook',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

afterEach(() => {
  cleanup()
})

describe('EditorContent', () => {
  it('maps rich-editor annotation lines after front matter to source lines', () => {
    expect(getMarkdownSourceLineOffset('---\ntitle: x\n---\n')).toBe(3)
    expect(getMarkdownSourceLineOffset('+++\ntitle = "x"\n+++\n')).toBe(3)
    expect(getMarkdownSourceLineOffset('---\r\ntitle: x\r\n---\r\n')).toBe(3)
    expect(getMarkdownSourceLineOffset('---\rtitle: x\n---\r\n')).toBe(3)
  })

  it('counts newline-heavy front matter offsets without regex match', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const frontMatterRaw = `---\n${'title: x\n'.repeat(12_000)}---\n`

    expect(getMarkdownSourceLineOffset(frontMatterRaw)).toBe(12_002)
    expect(matchSpy).not.toHaveBeenCalled()
  })

  it('routes .docx to the lazy DocxViewer in the edit-mode binary branch', async () => {
    const activeFile = createOpenFile({
      id: '/repo/file.docx',
      filePath: '/repo/file.docx',
      relativePath: 'file.docx',
      language: 'docx'
    })
    render(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{
          [activeFile.id]: {
            content: 'aGVsbG8=',
            isBinary: true,
            isImage: true,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          }
        }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="docx"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="rich"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId('viewer-docx')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('viewer-xlsx')).not.toBeInTheDocument()
    expect(screen.queryByTestId('viewer-image')).not.toBeInTheDocument()
  })

  it('routes .xlsx to the lazy XlsxViewer in the edit-mode binary branch', async () => {
    const activeFile = createOpenFile({
      id: '/repo/file.xlsx',
      filePath: '/repo/file.xlsx',
      relativePath: 'file.xlsx',
      language: 'xlsx'
    })
    render(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{
          [activeFile.id]: {
            content: 'aGVsbG8=',
            isBinary: true,
            isImage: true,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="xlsx"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="rich"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId('viewer-xlsx')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('viewer-docx')).not.toBeInTheDocument()
  })

  it('routes .png to the ImageViewer in the edit-mode binary branch', async () => {
    const activeFile = createOpenFile({
      id: '/repo/file.png',
      filePath: '/repo/file.png',
      relativePath: 'file.png',
      language: 'png'
    })
    render(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{
          [activeFile.id]: {
            content: 'aGVsbG8=',
            isBinary: true,
            isImage: true,
            mimeType: 'image/png'
          }
        }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="png"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="rich"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId('viewer-image')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('viewer-docx')).not.toBeInTheDocument()
    expect(screen.queryByTestId('viewer-xlsx')).not.toBeInTheDocument()
  })

  it('routes .docx to the lazy DocxViewer in the conflict-review branch', async () => {
    const docxFile = createOpenFile({
      id: '/repo/file.docx',
      filePath: '/repo/file.docx',
      relativePath: 'file.docx',
      language: 'docx'
    })
    const conflictFile = createOpenFile({
      id: 'conflict:/repo',
      filePath: '/repo',
      relativePath: '',
      language: 'folder',
      mode: 'conflict-review',
      conflictReview: {
        kind: 'conflict-review',
        selectedFileId: docxFile.id,
        entries: []
      } as never
    })
    render(
      <EditorContent
        activeFile={conflictFile}
        viewStateScopeId={conflictFile.id}
        fileContents={{
          [docxFile.id]: {
            content: 'aGVsbG8=',
            isBinary: true,
            isImage: true,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          }
        }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[docxFile, conflictFile]}
        worktreeEntries={[]}
        resolvedLanguage="conflict-review"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="rich"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId('viewer-docx')).toBeInTheDocument()
    })
  })
})
