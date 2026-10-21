// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'

const store = vi.hoisted(() => {
  const initialOverride: Record<string, boolean> = {}
  const state = {
    markdownRichModeSizeOverride: initialOverride,
    setMarkdownRichModeSizeOverride: (fileId: string, enabled: boolean): void => {
      state.markdownRichModeSizeOverride = {
        ...state.markdownRichModeSizeOverride,
        [fileId]: enabled
      }
    },
    reloadOpenCheckRunDetailsTab: () => {}
  }
  return state
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (storeState: typeof store) => unknown) => selector(store), {
    getState: () => store
  })
}))

vi.mock('./editor-lazy-views', async () => {
  const { useState } = await import('react')
  let nextPreviewInstance = 0
  const Preview = () => {
    const [instance] = useState(() => ++nextPreviewInstance)
    return <div data-editor-view="preview" data-preview-instance={instance} />
  }
  const view = (name: string) => () => <div data-editor-view={name} />
  return {
    MonacoEditor: view('source'),
    CombinedDiffViewer: view('combined-diff'),
    RichMarkdownEditor: view('rich-editor'),
    MarkdownPreview: Preview,
    DiffViewer: view('diff'),
    ImageDiffViewer: view('image-diff')
  }
})

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

import { EditorContent } from './EditorContent'
import { EditorDiffFileSurface } from './EditorDiffFileSurface'
import type { useMarkdownDocuments } from './useMarkdownDocuments'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import { MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES } from './markdown-rich-size-limit'
import { getEditorPanelRenderModel } from './editor-panel-render-model'

// Why: preview/rich surfaces build the whole document in one task; 2 MB blocked
// the renderer 7.8 s at 2.3 GB and 5 MB 38 s at 4 GB (scan29 crash reports).
const mediumDoc = 'a'.repeat(RICH_MARKDOWN_MAX_SIZE_BYTES + 1024)
const hugeDoc = 'a'.repeat(MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES + 1)
// Multibyte text whose UTF-16 length is under the cap but UTF-8 size is over it.
const hugeCjkDoc = '中'.repeat(Math.ceil((MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES + 1) / 3))

const sourceFile: OpenFile = {
  id: '/repo/BIG.md',
  filePath: '/repo/BIG.md',
  relativePath: 'BIG.md',
  worktreeId: 'wt-1',
  language: 'markdown',
  mode: 'edit',
  isDirty: false
}
const previewTab: OpenFile = {
  ...sourceFile,
  id: `markdown-preview::${sourceFile.id}`,
  mode: 'markdown-preview',
  markdownPreviewSourceFileId: sourceFile.id
}

function richRenderMode(content: string, sizeOverridden: boolean) {
  return getEditorPanelRenderModel({
    activeFile: sourceFile,
    fileContents: { [sourceFile.id]: { content, isBinary: false } },
    editorDrafts: {},
    gitStatusEntries: undefined,
    gitBranchEntries: undefined,
    markdownViewMode: { [sourceFile.id]: 'rich' },
    markdownRichModeSizeOverridden: sizeOverridden,
    isChangesMode: false,
    canOpenWorkspaceFileBrowser: true
  }).inlineMarkdownRenderState?.renderMode
}

function renderPreviewTab(content: string) {
  const fileContents = { [previewTab.id]: { content, isBinary: false } }
  const props = {
    activeFile: previewTab,
    viewStateScopeId: 'stable-preview-tab',
    fileContents,
    diffContents: {},
    editBuffers: {},
    openFiles: [sourceFile, previewTab],
    worktreeEntries: [],
    resolvedLanguage: 'markdown',
    isMarkdown: true,
    isMermaid: false,
    isCsv: false,
    isNotebook: false,
    mdViewMode: 'rich' as const,
    inlineMarkdownRenderState: null,
    isChangesMode: false,
    sideBySide: false,
    pendingEditorReveal: null,
    handleContentChange: vi.fn(),
    handleContentChangeForFile: vi.fn(),
    handleDirtyStateHint: vi.fn(),
    handleSave: vi.fn(),
    handleSaveForFile: vi.fn(),
    reloadContent: vi.fn()
  }
  const view = render(<EditorContent {...props} />)
  return {
    view,
    rerender: (overrides: Partial<typeof props> = {}) =>
      view.rerender(<EditorContent {...props} {...overrides} />),
    isPreviewRendered: () => view.container.querySelector('[data-editor-view="preview"]') !== null
  }
}

const diffTab: OpenFile = {
  ...sourceFile,
  id: 'diff::unstaged::/repo/BIG.md',
  mode: 'diff',
  diffSource: 'unstaged'
}

const markdownDocumentsStub: ReturnType<typeof useMarkdownDocuments> = {
  markdownDocuments: [],
  openMarkdownDocument: async () => {},
  onOpenDocLink: () => {},
  previewProps: { markdownDocuments: [], onOpenDocument: async () => {} },
  mdSave: async () => true
}

function renderDiffPreview(content: string) {
  const diffContent: GitDiffResult = {
    kind: 'text',
    originalContent: '',
    modifiedContent: content,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
  const props = {
    activeFile: diffTab,
    diffContent,
    editBuffer: undefined,
    resolvedLanguage: 'markdown',
    sideBySide: false,
    viewStateScopeId: diffTab.id,
    diffViewStateKey: diffTab.id,
    mdViewMode: 'preview' as const,
    isMarkdown: true,
    showMarkdownTableOfContents: false,
    onCloseMarkdownTableOfContents: vi.fn(),
    markdownAnnotationsEnabled: false,
    markdownDocuments: markdownDocumentsStub,
    onContentChange: vi.fn(),
    onSave: vi.fn(),
    reloadContent: vi.fn()
  }
  const view = render(<EditorDiffFileSurface {...props} />)
  return {
    rerender: () => view.rerender(<EditorDiffFileSurface {...props} />),
    isPreviewRendered: () => view.container.querySelector('[data-editor-view="preview"]') !== null
  }
}

afterEach(() => {
  cleanup()
  store.markdownRichModeSizeOverride = {}
})

describe('large markdown render guard', () => {
  it('"Open anyway" still reaches the rich editor below the hard cap', () => {
    expect(richRenderMode(mediumDoc, false)).toBe('source')
    expect(richRenderMode(mediumDoc, true)).toBe('rich-editor')
  })

  it('"Open anyway" cannot push a document past the hard cap into the rich editor', () => {
    expect(richRenderMode(hugeDoc, true)).toBe('source')
    expect(richRenderMode(hugeCjkDoc, true)).toBe('source')
  })

  it('keeps a preview for content updates but remounts when a stable tab changes file path', () => {
    const preview = renderPreviewTab('# Original')
    const instance = () =>
      preview.view.container
        .querySelector('[data-preview-instance]')
        ?.getAttribute('data-preview-instance')
    const originalInstance = instance()
    preview.rerender({
      fileContents: { [previewTab.id]: { content: '# Updated', isBinary: false } }
    })
    expect(instance()).toBe(originalInstance)
    const movedTab = {
      ...previewTab,
      id: 'markdown-preview::/repo/MOVED.md',
      filePath: '/repo/MOVED.md'
    }
    preview.rerender({
      activeFile: movedTab,
      fileContents: { [movedTab.id]: { content: '# Updated', isBinary: false } }
    })
    expect(instance()).not.toBe(originalInstance)
  })

  it('preview tab renders small documents directly', () => {
    expect(renderPreviewTab('# Small').isPreviewRendered()).toBe(true)
  })

  it('preview tab sends documents above the former cap to the large preview', () => {
    expect(renderPreviewTab(mediumDoc).isPreviewRendered()).toBe(true)
    cleanup()
    expect(renderPreviewTab(hugeDoc).isPreviewRendered()).toBe(true)
  })

  it('preview tab never passes input above the worker limit to the renderer', () => {
    store.markdownRichModeSizeOverride = { [previewTab.id]: true }
    expect(renderPreviewTab('x'.repeat(8 * 1024 * 1024 + 1)).isPreviewRendered()).toBe(false)
    expect(screen.queryByRole('button', { name: 'Render anyway' })).toBeNull()
  })

  it('diff preview routes larger documents through the same preview surface', () => {
    expect(renderDiffPreview('# Small').isPreviewRendered()).toBe(true)
    cleanup()
    expect(renderDiffPreview(mediumDoc).isPreviewRendered()).toBe(true)
    cleanup()
    expect(renderDiffPreview(hugeDoc).isPreviewRendered()).toBe(true)
  })

  it('diff preview keeps its input cap despite a rich-mode override', () => {
    store.markdownRichModeSizeOverride = { [diffTab.id]: true }
    expect(renderDiffPreview('x'.repeat(8 * 1024 * 1024 + 1)).isPreviewRendered()).toBe(false)
    expect(screen.queryByRole('button', { name: 'Render anyway' })).toBeNull()
  })
})
