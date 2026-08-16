// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { richMarkdownSelectionCache } from '@/lib/scroll-cache'
import { useClosedEditorTabCleanup } from './useClosedEditorTabCleanup'

vi.mock('monaco-editor', () => ({
  editor: { getModel: vi.fn(() => null) },
  Uri: { parse: vi.fn((value: string) => value) }
}))

const openFile = {
  id: '/repo/a.md',
  filePath: '/repo/a.md',
  relativePath: 'a.md',
  worktreeId: 'worktree-1',
  language: 'markdown',
  isDirty: false,
  mode: 'edit'
} satisfies OpenFile

beforeEach(() => {
  richMarkdownSelectionCache.clear()
})

describe('useClosedEditorTabCleanup', () => {
  it('removes rich selections owned by a closed tab only', () => {
    richMarkdownSelectionCache.set('/repo/a.md:rich', { from: 2, to: 2 })
    richMarkdownSelectionCache.set('/repo/a.md::pane-2:rich', { from: 3, to: 4 })
    richMarkdownSelectionCache.set('/repo/b.md:rich', { from: 5, to: 5 })
    const { rerender } = renderHook(({ files }) => useClosedEditorTabCleanup(files), {
      initialProps: { files: [openFile] }
    })

    rerender({ files: [] })

    expect(richMarkdownSelectionCache.has('/repo/a.md:rich')).toBe(false)
    expect(richMarkdownSelectionCache.has('/repo/a.md::pane-2:rich')).toBe(false)
    expect(richMarkdownSelectionCache.get('/repo/b.md:rich')).toEqual({ from: 5, to: 5 })
  })
})
