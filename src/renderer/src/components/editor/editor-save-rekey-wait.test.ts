import { afterEach, expect, it, vi } from 'vitest'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  requestEditorFileSave,
  requestEditorSaveQuiesce,
  releaseExternalEditorSaveWait
} from './editor-autosave'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
afterEach(() => vi.unstubAllGlobals())

/** Suspend real queue completion at the filesystem boundary. */
function pendingWrite() {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

it.each([false, true])(
  'drains the pre-rekey write after close (caller attaches late=%s)',
  async (late) => {
    const writeFile = stubEditorWindow()
    const store = createEditorStore()
    if (store.getState().settings) {
      store.setState((state) => ({
        settings: state.settings && { ...state.settings, editorAutoSave: false }
      }))
    }
    const file = {
      id: 'old-id',
      filePath: '/tmp/prompt.txt',
      relativePath: 'prompt.txt',
      worktreeId: 'wt-1',
      language: 'plaintext',
      mode: 'edit' as const,
      isDirty: true,
      externalEditorWaitIds: late ? undefined : ['caller']
    }
    store.setState({ openFiles: [file], editorDrafts: { 'old-id': 'saved contents' } })
    const blocked = pendingWrite()
    const newer = pendingWrite()
    writeFile.mockReturnValueOnce(blocked.promise).mockReturnValueOnce(newer.promise)
    const dispose = attachEditorAutosaveController(store)
    try {
      // Reproduce a new save entering after the move coordinator's pre-drain.
      await requestEditorSaveQuiesce({ fileId: 'old-id' })
      const save = requestEditorFileSave({ fileId: 'old-id' })
      await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce())
      if (late) {
        store.setState({ openFiles: [{ ...file, externalEditorWaitIds: ['caller'] }] })
      }
      store.setState({
        openFiles: [
          {
            ...file,
            id: 'new-id',
            filePath: '/tmp/moved/prompt.txt',
            externalEditorWaitIds: ['caller']
          }
        ]
      })
      store.setState({ editorDrafts: { 'new-id': 'newer contents' } })
      const newerSave = requestEditorFileSave({ fileId: 'new-id' })
      await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2))
      store.setState({ openFiles: [], editorDrafts: {} })
      const finished = vi.fn()
      const drain = Promise.all([
        requestEditorSaveQuiesce({ fileId: 'new-id' }),
        requestEditorSaveQuiesce({ externalEditorWaitId: 'caller' })
      ]).then(finished)
      newer.resolve()
      await newerSave
      await new Promise((resolve) => setImmediate(resolve))
      expect(finished).not.toHaveBeenCalled()
      blocked.resolve()
      await save
      await drain
      expect(finished).toHaveBeenCalledOnce()
      releaseExternalEditorSaveWait('caller')
    } finally {
      blocked.resolve()
      newer.resolve()
      dispose()
    }
  }
)

it('does not cancel or wait for a different editor reusing the old ID', async () => {
  const writeFile = stubEditorWindow()
  const store = createEditorStore()
  store.setState((state) => ({
    settings: state.settings && { ...state.settings, editorAutoSave: false }
  }))
  const file = {
    id: 'old-id',
    filePath: '/tmp/prompt.txt',
    relativePath: 'prompt.txt',
    worktreeId: 'wt-1',
    language: 'plaintext',
    mode: 'edit' as const,
    isDirty: true
  }
  store.setState({
    openFiles: [{ ...file, externalEditorWaitIds: ['caller'] }],
    editorDrafts: { 'old-id': 'original' }
  })
  const oldWrite = pendingWrite()
  const otherWrite = pendingWrite()
  writeFile.mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(otherWrite.promise)
  const dispose = attachEditorAutosaveController(store)
  try {
    const save = requestEditorFileSave({ fileId: 'old-id' })
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
    store.setState({
      openFiles: [
        {
          ...file,
          id: 'new-id',
          filePath: '/tmp/moved/prompt.txt',
          externalEditorWaitIds: ['caller']
        },
        file
      ],
      editorDrafts: { 'old-id': 'unrelated', 'new-id': 'original' }
    })
    const otherSave = requestEditorFileSave({ fileId: 'old-id' })
    store.setState({ openFiles: [file] })
    const drain = requestEditorSaveQuiesce({ externalEditorWaitId: 'caller' })
    oldWrite.resolve()
    await save
    await drain
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2))
    expect(writeFile.mock.calls[1]?.[0]).toMatchObject({ content: 'unrelated' })
    otherWrite.resolve()
    await otherSave
  } finally {
    oldWrite.resolve()
    otherWrite.resolve()
    dispose()
  }
})

it('does not acknowledge a caller drain without a save controller', async () => {
  stubEditorWindow()
  await expect(requestEditorSaveQuiesce({ externalEditorWaitId: 'caller' })).rejects.toThrow(
    'save controller is unavailable'
  )
})

it.each([false, true])(
  'rejects a caller drain when a write fails (already settled=%s)',
  async (settled) => {
    const writeFile = stubEditorWindow()
    const store = createEditorStore()
    store.setState((state) => ({
      settings: state.settings && { ...state.settings, editorAutoSave: false },
      openFiles: [
        {
          id: 'file',
          filePath: '/tmp/prompt.txt',
          relativePath: 'prompt.txt',
          worktreeId: 'wt-1',
          language: 'plaintext',
          mode: 'edit',
          isDirty: true,
          externalEditorWaitIds: ['caller']
        }
      ],
      editorDrafts: { file: 'unsaved contents' }
    }))
    const write = pendingWrite()
    writeFile.mockReturnValueOnce(write.promise)
    const dispose = attachEditorAutosaveController(store)
    try {
      const save = expect(requestEditorFileSave({ fileId: 'file' })).rejects.toThrow(
        'disk unavailable'
      )
      await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce())
      if (settled) {
        write.reject(new Error('disk unavailable'))
        await save
      }
      store.setState({ openFiles: [], editorDrafts: {} })
      const drain = expect(
        requestEditorSaveQuiesce({ externalEditorWaitId: 'caller' })
      ).rejects.toThrow('disk unavailable')
      write.reject(new Error('disk unavailable'))
      await save
      await drain
      releaseExternalEditorSaveWait('caller')
      await expect(
        requestEditorSaveQuiesce({ externalEditorWaitId: 'caller' })
      ).resolves.toBeUndefined()
    } finally {
      write.resolve()
      dispose()
    }
  }
)
