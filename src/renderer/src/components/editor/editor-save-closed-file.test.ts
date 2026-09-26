import { afterEach, expect, it, vi } from 'vitest'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
afterEach(() => {
  vi.unstubAllGlobals()
})

it('does not release a closed-file waiter while the old tab is still writing', async () => {
  const writeFile = stubEditorWindow()
  const store = createEditorStore()
  store.setState({
    openFiles: [
      {
        id: 'file-1',
        filePath: '/tmp/prompt.txt',
        relativePath: 'prompt.txt',
        worktreeId: 'wt-1',
        language: 'plaintext',
        mode: 'edit',
        isDirty: true
      }
    ],
    editorDrafts: { 'file-1': 'edited prompt' }
  })
  let finishWrite: () => void = () => {}
  writeFile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishWrite = resolve
      })
  )
  const dispose = attachEditorAutosaveController(store)
  try {
    const save = requestEditorFileSave({ fileId: 'file-1' })
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce())
    store.setState({ openFiles: [], editorDrafts: {} })
    const done = vi.fn()
    const quiesce = requestEditorSaveQuiesce({ fileId: 'file-1' }).then(done)
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).not.toHaveBeenCalled()
    finishWrite()
    await save
    await quiesce
    expect(done).toHaveBeenCalledOnce()
  } finally {
    finishWrite()
    dispose()
  }
})
