import { describe, expect, it } from 'vitest'
import { getEditorDisplayLabel } from './editor-labels'
import type { OpenFile } from '@/store/slices/editor'

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/docs/README.md',
    filePath: '/repo/docs/README.md',
    relativePath: 'docs/README.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('getEditorDisplayLabel', () => {
  it('adds a preview suffix for markdown preview tabs', () => {
    expect(
      getEditorDisplayLabel(
        makeOpenFile({
          id: 'markdown-preview::/repo/docs/README.md',
          mode: 'markdown-preview'
        })
      )
    ).toBe('README.md (preview)')
  })

  it('uses the requested label variant for markdown preview tabs', () => {
    expect(
      getEditorDisplayLabel(
        makeOpenFile({
          id: 'markdown-preview::/repo/docs/README.md',
          mode: 'markdown-preview'
        }),
        'relativePath'
      )
    ).toBe('docs/README.md (preview)')
  })
})
