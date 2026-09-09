import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

function openFile(store: ReturnType<typeof createEditorStore>, filePath: string): void {
  store.getState().openFile({
    filePath,
    relativePath: filePath.replace('/repo/', ''),
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
}

describe('createEditorSlice per-file text direction override', () => {
  it('stores an explicit override keyed by fileId', () => {
    const store = createEditorStore()

    store.getState().setEditorTextDirectionOverride('/repo/notes.md', 'rtl')

    expect(store.getState().editorTextDirectionByFile).toEqual({ '/repo/notes.md': 'rtl' })
  })

  it('deletes the entry when the override is cleared, so the file follows Settings again', () => {
    const store = createEditorStore()
    store.getState().setEditorTextDirectionOverride('/repo/notes.md', 'rtl')

    store.getState().setEditorTextDirectionOverride('/repo/notes.md', null)

    expect(store.getState().editorTextDirectionByFile).toEqual({})
  })

  it('is a no-op when clearing a file that has no override', () => {
    const store = createEditorStore()
    const before = store.getState().editorTextDirectionByFile

    store.getState().setEditorTextDirectionOverride('/repo/notes.md', null)

    expect(store.getState().editorTextDirectionByFile).toBe(before)
  })

  it('keeps overrides independent per file', () => {
    const store = createEditorStore()

    store.getState().setEditorTextDirectionOverride('/repo/a.md', 'rtl')
    store.getState().setEditorTextDirectionOverride('/repo/b.md', 'ltr')

    expect(store.getState().editorTextDirectionByFile).toEqual({
      '/repo/a.md': 'rtl',
      '/repo/b.md': 'ltr'
    })
  })

  it('drops the override when the file is closed, so it cannot leak across a session', () => {
    const store = createEditorStore()
    openFile(store, '/repo/notes.md')
    const fileId = store.getState().openFiles[0].id
    store.getState().setEditorTextDirectionOverride(fileId, 'rtl')

    store.getState().closeFile(fileId)

    expect(store.getState().editorTextDirectionByFile).toEqual({})
  })
})
