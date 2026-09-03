// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const classifiers = vi.hoisted(() => ({
  getUnsupportedMessage: vi.fn<(content: string) => string | null>(),
  exceedsSizeLimit: vi.fn<(content: string) => boolean>()
}))

// Why: the decision is what gets cached; the message is resolved from it per
// read so it can follow the active UI language. The stub uses the message text
// itself as the reason token so both seams stay observable.
vi.mock('./markdown-rich-mode', () => ({
  getMarkdownRichModeEligibilityDecision: ({
    content,
    sizeOverridden
  }: {
    content: string
    sizeOverridden: boolean
  }) => ({
    exceedsSizeLimit: !sizeOverridden && classifiers.exceedsSizeLimit(content),
    unsupportedReason: classifiers.getUnsupportedMessage(content)
  }),
  resolveMarkdownRichModeUnsupportedMessage: (reason: string | null) => reason
}))

vi.mock('./editor-lazy-views', () => {
  const view = (name: string) => () => <div data-editor-view={name} />
  return {
    MonacoEditor: view('source'),
    DiffViewer: view('diff'),
    CombinedDiffViewer: view('combined-diff'),
    RichMarkdownEditor: view('rich-editor'),
    MarkdownPreview: view('preview'),
    ImageViewer: view('image'),
    ImageDiffViewer: view('image-diff'),
    MermaidViewer: view('mermaid'),
    CsvViewer: view('csv'),
    IpynbViewer: view('notebook')
  }
})

vi.mock('./RichMarkdownErrorBoundary', () => ({
  RichMarkdownErrorBoundary: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('./useMarkdownDocuments', () => ({
  useMarkdownDocuments: () => ({
    markdownDocuments: [],
    onOpenDocLink: () => {},
    previewProps: { markdownDocuments: [], onOpenDocument: async () => {} },
    mdSave: async () => true
  })
}))

vi.mock('./useEditorConflictNavigation', () => ({
  useEditorConflictNavigation: () => () => undefined
}))

vi.mock('@/store', () => {
  const state = {
    markdownRichModeSizeOverridden: false,
    setMarkdownRichModeSizeOverride: () => {},
    reloadOpenCheckRunDetailsTab: () => {}
  }
  return {
    useAppStore: Object.assign(
      (selector: (storeState: typeof state) => unknown) => selector(state),
      { getState: () => state }
    )
  }
})

import { EditorContent } from './EditorContent'
import { getEditorPanelRenderModel } from './editor-panel-render-model'
import { resetMarkdownRichModeEligibilityCache } from './markdown-rich-mode-eligibility-cache'

function openFile(
  language: 'markdown' | 'typescript' = 'markdown',
  mode: 'edit' | 'markdown-preview' = 'edit'
): OpenFile {
  const extension = language === 'markdown' ? 'md' : 'ts'
  return {
    id: `/repo/notes.${extension}`,
    filePath: `/repo/notes.${extension}`,
    relativePath: `notes.${extension}`,
    worktreeId: 'wt-1',
    language,
    mode,
    isDirty: false
  }
}

function renderEditPath({
  content,
  language = 'markdown',
  viewMode = 'rich',
  mode = 'edit'
}: {
  content: string
  language?: 'markdown' | 'typescript'
  viewMode?: 'source' | 'rich' | 'preview'
  mode?: 'edit' | 'markdown-preview'
}) {
  const activeFile = openFile(language, mode)
  const fileContents = {
    [activeFile.id]: { content: '# Saved', isBinary: false }
  }
  const editorDrafts = { [activeFile.id]: content }
  const model = getEditorPanelRenderModel({
    activeFile,
    fileContents,
    editorDrafts,
    gitStatusEntries: undefined,
    gitBranchEntries: undefined,
    markdownViewMode: { [activeFile.id]: viewMode },
    markdownRichModeSizeOverridden: false,
    isChangesMode: false,
    canOpenWorkspaceFileBrowser: true
  })
  const view = render(
    <EditorContent
      activeFile={activeFile}
      viewStateScopeId={activeFile.id}
      fileContents={fileContents}
      diffContents={{}}
      editBuffers={editorDrafts}
      openFiles={[activeFile]}
      worktreeEntries={[]}
      resolvedLanguage={model.resolvedLanguage}
      isMarkdown={model.isMarkdown}
      isMermaid={model.isMermaid}
      isCsv={model.isCsv}
      isNotebook={model.isNotebook}
      mdViewMode={model.mdViewMode}
      inlineMarkdownRenderState={model.inlineMarkdownRenderState}
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

  return { model, view }
}

function getGuardedRenderModel({
  activeFileOverrides,
  fileContent = { content: '# Saved', isBinary: false },
  includeFileContent = true,
  isChangesMode = false
}: {
  activeFileOverrides?: Partial<OpenFile>
  fileContent?: FileContent
  includeFileContent?: boolean
  isChangesMode?: boolean
}) {
  const activeFile = { ...openFile(), ...activeFileOverrides }
  return getEditorPanelRenderModel({
    activeFile,
    fileContents: includeFileContent ? { [activeFile.id]: fileContent } : {},
    editorDrafts: { [activeFile.id]: '# Draft' },
    gitStatusEntries: undefined,
    gitBranchEntries: undefined,
    markdownViewMode: { [activeFile.id]: 'rich' },
    markdownRichModeSizeOverridden: false,
    isChangesMode,
    canOpenWorkspaceFileBrowser: true
  })
}

beforeEach(() => {
  resetMarkdownRichModeEligibilityCache()
  classifiers.getUnsupportedMessage.mockImplementation((content) =>
    content.includes('[reference]:') ? 'Reference links require source mode.' : null
  )
  classifiers.exceedsSizeLimit.mockImplementation((content) => content.includes('oversized'))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetMarkdownRichModeEligibilityCache()
})

describe('inline Markdown render classification', () => {
  it('classifies each rich draft once, including after content changes', () => {
    const first = renderEditPath({ content: '# First draft' })

    expect(first.view.container.innerHTML).toContain('data-editor-view="rich-editor"')
    expect(classifiers.getUnsupportedMessage).toHaveBeenCalledTimes(1)
    expect(classifiers.getUnsupportedMessage).toHaveBeenLastCalledWith('# First draft')
    expect(classifiers.exceedsSizeLimit).toHaveBeenCalledTimes(1)
    expect(classifiers.exceedsSizeLimit).toHaveBeenLastCalledWith('# First draft')

    first.view.unmount()
    const second = renderEditPath({ content: '# Changed draft' })

    expect(second.view.container.innerHTML).toContain('data-editor-view="rich-editor"')
    expect(classifiers.getUnsupportedMessage).toHaveBeenCalledTimes(2)
    expect(classifiers.getUnsupportedMessage).toHaveBeenLastCalledWith('# Changed draft')
    expect(classifiers.exceedsSizeLimit).toHaveBeenCalledTimes(2)
    expect(classifiers.exceedsSizeLimit).toHaveBeenLastCalledWith('# Changed draft')
  })

  it.each([
    {
      name: 'source Markdown',
      args: { content: '# Source', viewMode: 'source' as const },
      expectedView: 'source',
      canExport: false
    },
    {
      name: 'Markdown preview',
      args: { content: '# Preview', mode: 'markdown-preview' as const },
      expectedView: 'preview',
      canExport: true
    },
    {
      name: 'TypeScript',
      args: { content: 'const value = 1', language: 'typescript' as const },
      expectedView: 'source',
      canExport: false
    }
  ])('skips rich eligibility scans for $name', ({ args, expectedView, canExport }) => {
    const result = renderEditPath(args)

    expect(result.view.container.innerHTML).toContain(`data-editor-view="${expectedView}"`)
    expect(result.model.canExportMarkdownToPdf).toBe(canExport)
    expect(classifiers.getUnsupportedMessage).not.toHaveBeenCalled()
    expect(classifiers.exceedsSizeLimit).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'Changes mode', args: { isChangesMode: true } },
    { name: 'content that is still loading', args: { includeFileContent: false } },
    {
      name: 'binary content',
      args: { fileContent: { content: '', isBinary: true } }
    },
    {
      name: 'content with a load error',
      args: { fileContent: { content: '', isBinary: false, loadError: 'Read failed' } }
    },
    {
      name: 'read-only Markdown',
      args: { activeFileOverrides: { readOnly: true } }
    },
    {
      name: 'an unresolved conflict',
      args: {
        activeFileOverrides: {
          conflict: {
            kind: 'conflict-editable' as const,
            conflictKind: 'both_modified' as const,
            conflictStatus: 'unresolved' as const,
            conflictStatusSource: 'git' as const
          }
        }
      }
    },
    {
      name: 'a conflict placeholder',
      args: {
        activeFileOverrides: {
          conflict: {
            kind: 'conflict-placeholder' as const,
            conflictKind: 'both_deleted' as const,
            conflictStatus: 'unresolved' as const,
            conflictStatusSource: 'git' as const
          }
        }
      }
    }
  ])('skips rich eligibility scans for $name', ({ args }) => {
    const model = getGuardedRenderModel(args)

    expect(model.inlineMarkdownRenderState).toBeNull()
    expect(classifiers.getUnsupportedMessage).not.toHaveBeenCalled()
    expect(classifiers.exceedsSizeLimit).not.toHaveBeenCalled()
  })

  it('preserves unsupported and oversized rich-mode fallbacks', () => {
    const unsupported = renderEditPath({ content: '[reference]: https://example.com' })

    expect(unsupported.model.canExportMarkdownToPdf).toBe(false)
    expect(unsupported.view.getByText('Reference links require source mode.')).toBeTruthy()
    expect(unsupported.view.queryByText('Open anyway')).toBeNull()
    unsupported.view.unmount()

    const oversized = renderEditPath({ content: '# oversized' })

    expect(oversized.model.canExportMarkdownToPdf).toBe(false)
    expect(oversized.view.getByText(/File is larger than the .* rich editing limit/)).toBeTruthy()
    expect(oversized.view.getByText('Open anyway')).toBeTruthy()
  })
})
