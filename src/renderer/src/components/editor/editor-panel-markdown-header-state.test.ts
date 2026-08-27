import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  getActiveMarkdownDocumentContent,
  getEditorPanelMarkdownDocumentStateFileId,
  getEditorPanelMarkdownHeaderState
} from './editor-panel-markdown-header-state'

function makeFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/readme.md',
    filePath: '/repo/readme.md',
    relativePath: 'readme.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('getActiveMarkdownDocumentContent', () => {
  it('prefers the edit draft over the last loaded bytes', () => {
    expect(
      getActiveMarkdownDocumentContent(
        makeFile(),
        { '/repo/readme.md': '# Draft' },
        { '/repo/readme.md': { content: '# Saved', isBinary: false } }
      )
    ).toBe('# Draft')
  })

  it('reads preview drafts from the source file id', () => {
    const preview = makeFile({
      id: 'preview:/repo/readme.md',
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: '/repo/readme.md'
    })
    expect(getEditorPanelMarkdownDocumentStateFileId(preview)).toBe('/repo/readme.md')
    expect(
      getActiveMarkdownDocumentContent(
        preview,
        { '/repo/readme.md': '# From source' },
        { 'preview:/repo/readme.md': { content: '# Preview load', isBinary: false } }
      )
    ).toBe('# From source')
  })
})

describe('getEditorPanelMarkdownHeaderState', () => {
  it('enables copy for a loaded markdown edit tab', () => {
    const state = getEditorPanelMarkdownHeaderState({
      activeFile: makeFile(),
      isMarkdown: true,
      isDiffSurface: false,
      mdViewMode: 'rich',
      editorDrafts: {},
      fileContents: { '/repo/readme.md': { content: '# Hello', isBinary: false } }
    })
    expect(state.activeMarkdownContent).toBe('# Hello')
    expect(state.markdownCopyState).toEqual({ canShow: true, canCopy: true })
  })

  it('disables copy when the loaded file is binary', () => {
    const state = getEditorPanelMarkdownHeaderState({
      activeFile: makeFile(),
      isMarkdown: true,
      isDiffSurface: false,
      mdViewMode: 'rich',
      editorDrafts: {},
      fileContents: { '/repo/readme.md': { content: '', isBinary: true } }
    })
    expect(state.markdownCopyState.canCopy).toBe(false)
  })
})
