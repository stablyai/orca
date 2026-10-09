import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { floatingWorkspaceId } from '../../../../shared/floating-workspace-id'
import { getDiskBaselineSignature } from './diff-content-signature'
import { createEditorSaveQueue } from './editor-save-queue'

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), write: vi.fn() }))
vi.mock('@/runtime/floating-markdown-client', () => ({ readFloatingMarkdownTab: mocks.read }))
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeRuntimeFile: mocks.write
}))

const file: OpenFile = {
  id: '/remote/plan.md',
  filePath: '/remote/plan.md',
  relativePath: 'plan.md',
  worktreeId: floatingWorkspaceId('one'),
  runtimeEnvironmentId: 'one',
  language: 'markdown',
  mode: 'edit',
  isDirty: true,
  lastKnownDiskSignature: getDiskBaselineSignature('original')
}

beforeEach(() => {
  vi.clearAllMocks()
  replaceRuntimeEnvironmentRevisions([{ id: 'one', createdAt: 1, pairingRevision: 1 }])
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    openFiles: [file],
    editorDrafts: { [file.id]: 'edited' },
    runtimeEnvironmentCatalogHydrated: false
  })
  mocks.read.mockResolvedValue({ document: { content: 'original' }, save: mocks.save })
  mocks.save.mockResolvedValue(undefined)
})

describe('floating markdown save queue', () => {
  it('uses the existing host save and clears the draft only after success', async () => {
    const queue = createEditorSaveQueue(useAppStore)
    await queue.queueSave(file, 'edited')
    expect(mocks.save).toHaveBeenCalledWith('edited')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(useAppStore.getState().editorDrafts[file.id]).toBeUndefined()
    expect(useAppStore.getState().openFiles[0].isDirty).toBe(false)
    queue.dispose()
  })

  it('keeps the draft when another device changed the document', async () => {
    mocks.read.mockResolvedValue({ document: { content: 'changed elsewhere' }, save: mocks.save })
    const queue = createEditorSaveQueue(useAppStore)
    await expect(queue.queueSave(file, 'edited')).rejects.toThrow('remote document changed')
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(useAppStore.getState().editorDrafts[file.id]).toBe('edited')
    queue.dispose()
  })

  it('keeps the draft when the host rejects a racing save', async () => {
    mocks.save.mockRejectedValueOnce(new Error('conflict'))
    const queue = createEditorSaveQueue(useAppStore)
    await expect(queue.queueSave(file, 'edited')).rejects.toThrow('conflict')
    expect(useAppStore.getState().editorDrafts[file.id]).toBe('edited')
    expect(useAppStore.getState().openFiles[0].isDirty).toBe(true)
    queue.dispose()
  })
  it.each(['closed', 'moved', 'cancelled', 'repaired'] as const)(
    'does not write after the tab is %s during a slow read',
    async (change) => {
      let finishRead = () => {}
      mocks.read.mockReturnValue(
        new Promise((resolve) => {
          finishRead = () => resolve({ document: { content: 'original' }, save: mocks.save })
        })
      )
      const queue = createEditorSaveQueue(useAppStore)
      const saving = queue.queueSave(file, 'edited')
      const settled = saving.catch(() => undefined)
      await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
      if (change === 'closed') {
        useAppStore.setState({ openFiles: [] })
      } else if (change === 'moved') {
        useAppStore.setState({
          openFiles: [
            { ...file, worktreeId: floatingWorkspaceId('two'), runtimeEnvironmentId: 'two' }
          ]
        })
      } else if (change === 'repaired') {
        replaceRuntimeEnvironmentRevisions([{ id: 'one', createdAt: 1, pairingRevision: 2 }])
      } else {
        queue.bumpSaveGeneration(file.id)
      }
      finishRead()
      await settled
      expect(mocks.save).not.toHaveBeenCalled()
      expect(mocks.write).not.toHaveBeenCalled()
      expect(useAppStore.getState().editorDrafts[file.id]).toBe('edited')
      queue.dispose()
    }
  )
})
