import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import type { GitStatusEntry } from '../../../../shared/types'
import type { FileContent } from './editor-panel-content-types'
import { getEditorPanelRenderModel } from './editor-panel-render-model'

function markdownFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/README.md',
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

function textContent(overrides: Partial<FileContent> = {}): FileContent {
  return {
    content: '# Hello',
    isBinary: false,
    ...overrides
  }
}

function renderModel(args: {
  activeFile?: OpenFile
  fileContents?: Record<string, FileContent>
  editorDrafts?: Record<string, string>
  markdownViewMode?: Record<string, 'source' | 'rich' | 'preview'>
  isChangesMode?: boolean
  gitStatusByWorktree?: Record<string, GitStatusEntry[]>
}) {
  const activeFile = args.activeFile ?? markdownFile()
  return getEditorPanelRenderModel({
    activeFile,
    fileContents: args.fileContents ?? { '/repo/README.md': textContent() },
    editorDrafts: args.editorDrafts ?? {},
    gitStatusEntries: args.gitStatusByWorktree?.[activeFile.worktreeId],
    gitBranchEntries: undefined,
    markdownViewMode: args.markdownViewMode ?? {},
    isChangesMode: args.isChangesMode ?? false
  })
}

function htmlFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/mock.html',
    filePath: '/repo/mock.html',
    relativePath: 'mock.html',
    worktreeId: 'wt-1',
    language: 'html',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

describe('getEditorPanelRenderModel HTML preview affordance', () => {
  it('enables preview for HTML edit tabs', () => {
    expect(renderModel({ activeFile: htmlFile(), fileContents: {} }).canOpenPreviewToSide).toBe(
      true
    )
  })

  it('enables preview for single HTML diffs whose file exists on disk', () => {
    const model = renderModel({
      activeFile: htmlFile({ mode: 'diff', diffSource: 'unstaged' } as Partial<OpenFile>),
      fileContents: {},
      gitStatusByWorktree: {
        'wt-1': [{ path: 'mock.html', status: 'modified', area: 'unstaged' }]
      }
    })

    expect(model.canOpenPreviewToSide).toBe(true)
  })

  it('disables preview for diffs of deleted HTML files', () => {
    const model = renderModel({
      activeFile: htmlFile({ mode: 'diff', diffSource: 'unstaged' } as Partial<OpenFile>),
      fileContents: {},
      gitStatusByWorktree: {
        'wt-1': [{ path: 'mock.html', status: 'deleted', area: 'unstaged' }]
      }
    })

    expect(model.canOpenPreviewToSide).toBe(false)
  })

  it('disables preview for commit diffs whose content may not match disk', () => {
    const model = renderModel({
      activeFile: htmlFile({ mode: 'diff', diffSource: 'commit' } as Partial<OpenFile>),
      fileContents: {}
    })

    expect(model.canOpenPreviewToSide).toBe(false)
  })

  it('disables preview for non-HTML diffs', () => {
    const model = renderModel({
      activeFile: markdownFile({ mode: 'diff', diffSource: 'unstaged' } as Partial<OpenFile>),
      fileContents: {}
    })

    expect(model.canOpenPreviewToSide).toBe(false)
  })
})

describe('getEditorPanelRenderModel read-only raw rendering (AI Vault View Log)', () => {
  it('renders a read-only markdown log as raw source with no markdown viewer or chrome', () => {
    const model = renderModel({ activeFile: markdownFile({ readOnly: true }) })

    // Raw text renderer, not the rich/preview markdown surface.
    expect(model.isMarkdown).toBe(false)
    expect(model.hasViewModeToggle).toBe(false)
    expect(model.canShowMarkdownPreview).toBe(false)
    expect(model.canExportMarkdownToPdf).toBe(false)
    expect(model.canShowMarkdownTableOfContents).toBe(false)
    // Real language is preserved so Monaco still tokenizes the read-only source.
    expect(model.resolvedLanguage).toBe('markdown')
  })

  it('keeps markdown chrome for ordinary writable markdown tabs', () => {
    const model = renderModel({ activeFile: markdownFile() })
    expect(model.isMarkdown).toBe(true)
    expect(model.hasViewModeToggle).toBe(true)
  })
})

describe('getEditorPanelRenderModel markdown export affordance', () => {
  it('enables export for rendered markdown edit tabs', () => {
    expect(renderModel({}).canExportMarkdownToPdf).toBe(true)
  })

  it('disables export when an inline markdown tab renders Changes mode', () => {
    expect(renderModel({ isChangesMode: true }).canExportMarkdownToPdf).toBe(false)
  })

  it('uses unsaved drafts when resolving rich markdown fallback', () => {
    const model = renderModel({
      markdownViewMode: { '/repo/README.md': 'rich' },
      editorDrafts: { '/repo/README.md': '[example]: https://example.com' }
    })

    expect(model.canExportMarkdownToPdf).toBe(false)
  })

  it('disables rich export when a multibyte character crosses the byte limit', () => {
    const model = renderModel({
      markdownViewMode: { '/repo/README.md': 'rich' },
      editorDrafts: { '/repo/README.md': `${'a'.repeat(RICH_MARKDOWN_MAX_SIZE_BYTES)}\u00e9` }
    })

    expect(model.shouldShowMarkdownExportAction).toBe(true)
    expect(model.canExportMarkdownToPdf).toBe(false)
  })

  it('disables edit export while content is still loading, even with a draft', () => {
    const model = renderModel({
      fileContents: {},
      editorDrafts: { '/repo/README.md': '# Draft' }
    })

    expect(model.shouldShowMarkdownExportAction).toBe(true)
    expect(model.canExportMarkdownToPdf).toBe(false)
  })

  it('enables export for loaded markdown preview tabs', () => {
    const preview = markdownFile({
      id: 'preview:/repo/README.md',
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: '/repo/README.md'
    } as Partial<OpenFile>)

    expect(
      renderModel({
        activeFile: preview,
        fileContents: { [preview.id]: textContent() }
      }).canExportMarkdownToPdf
    ).toBe(true)
  })

  it('disables preview export until rendered content can exist', () => {
    const preview = markdownFile({
      id: 'preview:/repo/README.md',
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: '/repo/README.md'
    } as Partial<OpenFile>)

    expect(renderModel({ activeFile: preview, fileContents: {} }).canExportMarkdownToPdf).toBe(
      false
    )
    expect(
      renderModel({
        activeFile: preview,
        fileContents: { [preview.id]: textContent({ loadError: 'missing' }) }
      }).canExportMarkdownToPdf
    ).toBe(false)
    expect(
      renderModel({
        activeFile: preview,
        fileContents: { [preview.id]: textContent({ isBinary: true }) }
      }).canExportMarkdownToPdf
    ).toBe(false)
  })
})
