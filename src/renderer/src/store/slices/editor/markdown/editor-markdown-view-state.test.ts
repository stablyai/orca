import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore as createEditorStore } from '../editor-slice-test-harness'

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

describe('createEditorSlice markdown view state', () => {
  it('drops markdown visibility for a preview replaced by a diff', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().setMarkdownFrontmatterVisible('/repo/docs/README.md', false)
    store.getState().setMarkdownTableOfContentsVisible('/repo/docs/README.md', true)

    store.getState().openDiff('wt-1', '/repo/docs/guide.md', 'docs/guide.md', 'markdown', false, {
      preview: true
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
  })

  it('keeps markdown visibility when another preview still references a replaced source', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/docs/README.md', false)
    store.getState().setMarkdownTableOfContentsVisible('/repo/docs/README.md', true)

    store.getState().openDiff('wt-1', '/repo/docs/guide.md', 'docs/guide.md', 'markdown', false, {
      preview: true
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({
      '/repo/docs/README.md': false
    })
    expect(store.getState().markdownTableOfContentsVisible).toEqual({
      '/repo/docs/README.md': true
    })
  })
})

describe('createEditorSlice markdown frontmatter visibility (#4468)', () => {
  it('keeps the visibility flag while a preview tab still references the source file', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().markdownFrontmatterVisible).toEqual({ '/repo/notes.md': false })

    store.getState().closeFile('markdown-preview::/repo/notes.md')

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })
})

describe('createEditorSlice openMarkdownPreview', () => {
  it('keeps preview-only same-path markdown previews separate by owner', () => {
    const store = createEditorStore()

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'README.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null,
      language: 'markdown'
    })

    const previews = store.getState().openFiles.filter((file) => file.mode === 'markdown-preview')
    expect(previews).toEqual([
      expect.objectContaining({
        id: 'markdown-preview::/repo/docs/README.md',
        markdownPreviewSourceFileId: '/repo/docs/README.md',
        worktreeId: 'wt-1'
      }),
      expect.objectContaining({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ])
  })

  it('keeps same-path markdown previews separate by source owner', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const floatingFile = store
      .getState()
      .openFiles.find((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
    expect(floatingFile).toBeDefined()

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().openMarkdownPreview(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown'
      },
      { sourceFileId: floatingFile?.id }
    )

    const previews = store.getState().openFiles.filter((file) => file.mode === 'markdown-preview')
    expect(previews).toHaveLength(2)
    expect(previews.map((file) => file.markdownPreviewSourceFileId)).toEqual([
      '/repo/docs/README.md',
      floatingFile?.id
    ])
  })
})
