import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'

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

function openMarkdown(store: ReturnType<typeof createEditorStore>, filePath: string): void {
  store.getState().openFile({
    filePath,
    relativePath: filePath.replace('/repo/', ''),
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
}

describe('createEditorSlice rich markdown size override', () => {
  it('records an opt-in per file and clears it when turned back off', () => {
    const store = createEditorStore()
    openMarkdown(store, '/repo/big.md')

    store.getState().setMarkdownRichModeSizeOverride('/repo/big.md', true)
    expect(store.getState().markdownRichModeSizeOverride).toEqual({ '/repo/big.md': true })

    store.getState().setMarkdownRichModeSizeOverride('/repo/big.md', false)
    expect(store.getState().markdownRichModeSizeOverride).toEqual({})
  })

  it('drops the opt-in when the file is closed', async () => {
    const store = createEditorStore()
    openMarkdown(store, '/repo/big.md')
    store.getState().setMarkdownRichModeSizeOverride('/repo/big.md', true)

    await store.getState().closeFile('/repo/big.md')

    expect(store.getState().markdownRichModeSizeOverride).toEqual({})
  })

  it('drops the opt-in for a replaced preview tab', () => {
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
    store.getState().setMarkdownRichModeSizeOverride('/repo/docs/README.md', true)

    store.getState().openFile(
      {
        filePath: '/repo/docs/guide.md',
        relativePath: 'docs/guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().markdownRichModeSizeOverride).toEqual({})
  })
})
