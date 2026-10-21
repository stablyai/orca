import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { createEditorSaveQueue, type EditorSaveQueue } from './editor-save-queue'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const PATH = '/repo/a.ts'

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: PATH,
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...patch
  }
}

/** Holds the next disk write until the returned release runs. */
function holdNextWrite(disk: FakeEditorDisk): () => void {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  // Why: the held write is always the first, so it lands unconditionally.
  disk.fs.writeFile.mockImplementationOnce(
    async ({ filePath, content }: { filePath: string; content: string }) => {
      await gate
      disk.files.set(filePath, content)
      return { ok: true }
    }
  )
  return release
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('editor save queue: one running and one queued save per record', () => {
  let disk: FakeEditorDisk
  let store: ReturnType<typeof createEditorStore>
  let queue: EditorSaveQueue

  const edit = (id: string, text: string): void => {
    store.getState().setEditorDraft(id, text)
    store.getState().markFileDirty(id, true)
  }
  const file = (id: string): OpenFile => {
    const found = store.getState().openFiles.find((openFile) => openFile.id === id)
    if (!found) {
      throw new Error(`no tab ${id}`)
    }
    return found
  }
  const writtenContents = (): string[] => disk.fs.writeFile.mock.calls.map(([args]) => args.content)

  beforeEach(() => {
    disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: '' }))
    store = createEditorStore()
    store.setState({ openFiles: [tab('a')] })
    withLoadedBaselines(store, disk)
    queue = createEditorSaveQueue(store)
  })

  afterEach(() => {
    queue.dispose()
    __clearSelfWriteRegistryForTests()
    vi.unstubAllGlobals()
  })

  it('coalesces requests behind a running save into one save of the latest text', async () => {
    edit('a', 'a')
    const release = holdNextWrite(disk)
    const first = queue.queueSave(file('a'), 'a')
    await flush()
    edit('a', 'ab')
    const second = queue.queueSave(file('a'), 'ab', 'autosave')
    edit('a', 'abc')
    const third = queue.queueSave(file('a'), 'abc')
    expect(third).toBe(second)

    release()
    expect(await Promise.all([first, second, third])).toEqual(['written', 'written', 'written'])
    expect(writtenContents()).toEqual(['a', 'abc'])
    expect(disk.files.get(PATH)).toBe('abc')
    expect(file('a').isDirty).toBe(false)
  })

  it('upgrades a queued autosave to the Overwrite that joins it', async () => {
    edit('a', 'a')
    const release = holdNextWrite(disk)
    const first = queue.queueSave(file('a'), 'a')
    await flush()
    edit('a', 'ab')
    void queue.queueSave(file('a'), 'ab', 'autosave')
    const overwrite = queue.queueSave(file('a'), 'ab', 'overwrite')

    release()
    await first
    expect(await overwrite).toBe('written')
    const calls = disk.fs.writeFile.mock.calls.map(([args]) => args.diskPrecondition)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBeDefined()
    expect(calls[1]).toBeUndefined()
  })

  it.each([
    ['user', 'written'],
    ['autosave', 'failed']
  ] as const)(
    'a queued %s save of a record the running save left clean writes nothing',
    async (trigger, expected) => {
      edit('a', 'a')
      const release = holdNextWrite(disk)
      const first = queue.queueSave(file('a'), 'a')
      const queued = queue.queueSave(file('a'), 'a', trigger)

      release()
      expect(await first).toBe('written')
      expect(await queued).toBe(expected)
      expect(writtenContents()).toEqual(['a'])
    }
  )

  it('serializes two tabs writing one file (edit + unstaged diff)', async () => {
    store.setState({
      openFiles: [
        ...store.getState().openFiles,
        tab('diff', { mode: 'diff', diffSource: 'unstaged' })
      ]
    })
    withLoadedBaselines(store, disk)
    edit('a', 'from edit')
    edit('diff', 'from diff')
    const release = holdNextWrite(disk)
    const editSave = queue.queueSave(file('a'), 'from edit')
    await flush()
    const diffSave = queue.queueSave(file('diff'), 'from diff')
    await flush()
    expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)

    release()
    expect(await editSave).toBe('written')
    // The diff's guarded write runs after the edit's landed, so it sees disk moved.
    expect(await diffSave).toBe('blocked-stale')
    expect(disk.files.get(PATH)).toBe('from edit')
  })

  it('settle (rename, delete, hot exit) drains the running and queued saves, cancelling neither', async () => {
    edit('a', 'a')
    const release = holdNextWrite(disk)
    const first = queue.queueSave(file('a'), 'a')
    await flush()
    edit('a', 'ab')
    const queued = queue.queueSave(file('a'), 'ab')
    let settled = false
    const settle = queue.settleFileSaves('a').then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)

    release()
    await settle
    expect(await first).toBe('written')
    expect(await queued).toBe('written')
    expect(disk.files.get(PATH)).toBe('ab')
    expect(file('a').isDirty).toBe(false)
  })

  it('settle drops the autosave timer', async () => {
    vi.useFakeTimers()
    try {
      edit('a', 'a')
      queue.syncAutoSave()
      await queue.settleFileSaves('a')
      await vi.advanceTimersByTimeAsync(5000)
      expect(disk.fs.writeFile).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
