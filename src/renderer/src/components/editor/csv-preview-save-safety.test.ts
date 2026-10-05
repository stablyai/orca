// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { createEditorStore } from '@/store/slices/editor-slice-test-harness'
import { createEditorSaveQueue } from './editor-save-queue'
import { canAutoSaveOpenFile } from './editor-autosave'

const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', () => ({ writeRuntimeFile: writeFile }))

it('blocks drafts, dirty state, autosave and explicit writes for paged previews', async () => {
  const store = createEditorStore()
  store.getState().openFile({
    filePath: '/repo/large.csv',
    relativePath: 'large.csv',
    worktreeId: 'wt-1',
    language: 'plaintext',
    mode: 'edit'
  })
  const fileId = store.getState().openFiles[0]!.id
  store.getState().setCsvPreviewOnly(fileId, true)
  store.getState().setEditorDraft(fileId, 'partial CSV')
  store.getState().markFileDirty(fileId, true)
  const file = store.getState().openFiles[0]!
  expect(store.getState().editorDrafts[fileId]).toBeUndefined()
  expect(file.isDirty).toBe(false)
  expect(canAutoSaveOpenFile(file)).toBe(false)
  const queue = createEditorSaveQueue(store)
  await expect(queue.queueSave(file, '')).rejects.toThrow('read-only')
  expect(writeFile).not.toHaveBeenCalled()
  queue.dispose()
  store.getState().setCsvPreviewOnly(fileId, false)
  store.getState().setEditorDraft(fileId, 'complete CSV')
  expect(store.getState().editorDrafts[fileId]).toBe('complete CSV')
})
