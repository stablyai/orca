import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
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
}) {
  return getEditorPanelRenderModel({
    activeFile: args.activeFile ?? markdownFile(),
    fileContents: args.fileContents ?? { '/repo/README.md': textContent() },
    editorDrafts: args.editorDrafts ?? {},
    gitStatusByWorktree: {},
    gitBranchChangesByWorktree: {},
    markdownViewMode: args.markdownViewMode ?? {},
    isChangesMode: args.isChangesMode ?? false
  })
}

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
