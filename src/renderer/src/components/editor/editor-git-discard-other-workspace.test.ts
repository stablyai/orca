// Git discard holds autosave across all workspace views of the same physical file until Git settles.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce
} from './autosave/editor-autosave'
import { attachEditorAutosaveController } from './autosave/editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from './autosave/editor-autosave-controller-test-fixture'
import { registerPendingEditorFlush } from './save/flush/editor-pending-flush'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const DISCARD_TARGET = { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'a.ts' }

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(openIn: string[]) {
  const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ '/repo/a.ts': 'saved change' }))
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
  const ids = openIn.map((worktreeId) =>
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
  )
  withLoadedBaselines(store, disk)
  const edit = (id: string, text: string): void => {
    store.getState().setEditorDraft(id, text)
    store.getState().markFileDirty(id, true)
  }
  for (const id of ids) {
    edit(id, 'unsaved edit')
  }
  const cleanup = attachEditorAutosaveController(store)
  const writes = (): number => disk.fs.writeFile.mock.calls.length
  return { disk, store, ids, edit, cleanup, writes }
}

it('git discard in one workspace pauses the same file autosave in another', async () => {
  const { disk, store, ids, edit, cleanup, writes } = setup(['wt-1', 'wt-2'])
  expect(new Set(ids).size).toBe(2)
  try {
    const release = await requestEditorSaveQuiesce(DISCARD_TARGET)
    // Typing in wt-2 while git runs must not start a new autosave of the file.
    edit(ids[1], 'unsaved edit, more')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    disk.files.set('/repo/a.ts', 'HEAD')
    notifyEditorExternalFileChange(DISCARD_TARGET)
    release()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    expect(disk.files.get('/repo/a.ts')).toBe('HEAD')
    const tabs = store.getState().openFiles
    expect(tabs.map((file) => file.externalMutation)).toEqual(['changed', 'changed'])
    expect(store.getState().editorDrafts[ids[1]]).toBe('unsaved edit, more')
  } finally {
    cleanup()
  }
})

it('pauses another workspace even when the discarding workspace has no tab of the file', async () => {
  const { disk, store, cleanup, writes } = setup(['wt-2'])
  try {
    const release = await requestEditorSaveQuiesce(DISCARD_TARGET)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    disk.files.set('/repo/a.ts', 'HEAD')
    release()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(disk.files.get('/repo/a.ts')).toBe('HEAD')
    expect(store.getState().openFiles[0].externalMutation).toBe('changed')
  } finally {
    cleanup()
  }
})

it('a discard slower than the backstop: banner, and no autosave from any tab until release', async () => {
  const { disk, store, ids, edit, cleanup, writes } = setup(['wt-1', 'wt-2'])
  try {
    const release = await requestEditorSaveQuiesce(DISCARD_TARGET)
    await vi.advanceTimersByTimeAsync(130_000)
    expect(writes()).toBe(0)
    expect(store.getState().openFiles.map((file) => file.externalMutation)).toEqual([
      'changed',
      'changed'
    ])
    // Dismissed banners must return while an overdue discard still holds the file.
    store.getState().setExternalMutation(ids[1], null)
    edit(ids[1], 'typed while git is still running')
    expect(store.getState().openFiles[1].externalMutation).toBe('changed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(writes()).toBe(0)
    disk.files.set('/repo/a.ts', 'HEAD')
    notifyEditorExternalFileChange(DISCARD_TARGET)
    release()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(disk.files.get('/repo/a.ts')).toBe('HEAD')
  } finally {
    cleanup()
  }
})

it('a quiesce that fails (unresolved CSV cell) fails the discard and releases its hold', async () => {
  const { disk, ids, edit, cleanup, writes } = setup(['wt-1'])
  const unregister = registerPendingEditorFlush(
    ids[0],
    () => {
      throw new Error('Resolve the pending CSV cell edit before saving.')
    },
    () => true
  )
  try {
    await expect(requestEditorSaveQuiesce(DISCARD_TARGET)).rejects.toThrow('pending CSV cell')
    unregister()
    edit(ids[0], 'cell resolved')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes()).toBe(1)
    expect(disk.files.get('/repo/a.ts')).toBe('cell resolved')
  } finally {
    unregister()
    cleanup()
  }
})

it("holds another workspace's unstaged diff tab of the file until release", async () => {
  const { disk, store, cleanup, writes } = setup([])
  store.getState().openDiff('wt-2', '/repo/a.ts', 'a.ts', 'typescript', false)
  const diff = store.getState().openFiles[0]
  expect(diff.diffSource).toBe('unstaged')
  withLoadedBaselines(store, disk)
  store.getState().setEditorDraft(diff.id, 'diff edit')
  store.getState().markFileDirty(diff.id, true)
  try {
    const release = await requestEditorSaveQuiesce(DISCARD_TARGET)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(writes()).toBe(0)
    release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(disk.files.get('/repo/a.ts')).toBe('diff edit')
  } finally {
    cleanup()
  }
})
