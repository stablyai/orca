import { describe, expect, it } from 'vitest'
import type { OpenFile } from '../types/open-file'
import { markdownViewModesForNewDefault } from './markdown-default-view-mode-action'

function file(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: `/repo/${id}`,
    relativePath: id,
    worktreeId: 'wt-1',
    language: 'plaintext',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

const openFiles = [
  file('a.md'),
  file('b.md'),
  file('c.ts'),
  file('d.md', { mode: 'diff', diffSource: 'unstaged' })
]

function state(markdownViewMode: Record<string, 'source' | 'rich'>) {
  return {
    openFiles,
    markdownViewMode,
    settings: { markdownDefaultViewMode: 'rich' as const }
  }
}

describe('markdownViewModesForNewDefault', () => {
  it('pins untoggled Markdown edit tabs to the old default', () => {
    expect(markdownViewModesForNewDefault(state({}), 'source')).toEqual({
      'a.md': 'rich',
      'b.md': 'rich'
    })
  })

  it('keeps explicit per-tab choices', () => {
    expect(markdownViewModesForNewDefault(state({ 'b.md': 'source' }), 'source')).toEqual({
      'a.md': 'rich',
      'b.md': 'source'
    })
  })

  it('pins nothing when the default does not change', () => {
    expect(markdownViewModesForNewDefault(state({}), 'rich')).toEqual({})
  })
})
