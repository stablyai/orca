import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
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
const DELAY_MS = 1000

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
  disk.fs.writeFile.mockImplementationOnce(
    async ({ filePath, content }: { filePath: string; content: string }) => {
      await gate
      disk.files.set(filePath, content)
      return { ok: true }
    }
  )
  return release
}

// Views of one record in two workspaces, through the real record middleware and identity index.
describe('editor save queue: one autosave timer per record across its views', () => {
  let disk: FakeEditorDisk
  let store: ReturnType<typeof createEditorStore>
  let queue: EditorSaveQueue

  // The record middleware puts views of one file on one record by their identity.
  const share = (views: OpenFile[]): void => {
    store.setState({ openFiles: views })
    const recordIds = new Set(views.map((open) => store.getState().editorBufferIdOf[open.id]))
    expect(recordIds.size).toBe(1)
  }
  const type = (viewId: string, text: string): void => {
    store.getState().setEditorDraft(viewId, text)
    store.getState().markFileDirty(viewId, true)
    queue.syncAutoSave()
  }
  const view = (id: string): OpenFile => {
    const found = store.getState().openFiles.find((openFile) => openFile.id === id)
    if (!found) {
      throw new Error(`no view ${id}`)
    }
    return found
  }
  const writtenContents = (): string[] => disk.fs.writeFile.mock.calls.map(([args]) => args.content)

  beforeEach(() => {
    vi.useFakeTimers()
    disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: '' }))
    store = createEditorStore()
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
          makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
        ]
      }
    })
    share([tab('w1'), tab('w2', { worktreeId: 'wt-2' })])
    withLoadedBaselines(store, disk)
    queue = createEditorSaveQueue(store)
  })

  afterEach(() => {
    queue.dispose()
    __clearSelfWriteRegistryForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('writes typing from two workspaces once, with the latest text, and cleans both views', async () => {
    type('w1', 'abc')
    await vi.advanceTimersByTimeAsync(DELAY_MS / 2)
    type('w2', 'abcd')
    await vi.advanceTimersByTimeAsync(DELAY_MS)

    expect(writtenContents()).toEqual(['abcd'])
    expect(view('w1').isDirty).toBe(false)
    expect(view('w2').isDirty).toBe(false)
    expect(store.getState().editorDrafts).toEqual({})
  })

  it('keeps the timer when a read-only view of the record follows the writable one', async () => {
    share([view('w1'), tab('log', { readOnly: true })])
    withLoadedBaselines(store, disk)
    type('w1', 'abc')
    await vi.advanceTimersByTimeAsync(DELAY_MS)

    expect(writtenContents()).toEqual(['abc'])
    expect(view('log').isDirty).toBe(false)
  })

  it('keeps the timer when the view that scheduled it closes', async () => {
    type('w1', 'abc')
    await vi.advanceTimersByTimeAsync(DELAY_MS / 2)
    share([view('w2')])
    queue.syncAutoSave()
    await vi.advanceTimersByTimeAsync(DELAY_MS)

    expect(writtenContents()).toEqual(['abc'])
    expect(view('w2').isDirty).toBe(false)
  })

  it.each(['w1', 'w2'])(
    'schedules nothing for a conflicted record, whichever view (%s) typed',
    async (typist) => {
      store.getState().setExternalMutation('w2', 'changed')
      expect(view('w1').externalMutation).toBe('changed')
      type(typist, 'abc')
      await vi.advanceTimersByTimeAsync(DELAY_MS * 2)

      expect(writtenContents()).toEqual([])
      expect(view('w1').isDirty).toBe(true)
      expect(view('w2').isDirty).toBe(true)
    }
  )

  it("runs one view's Cmd+S that another view's settle waits behind", async () => {
    type('w1', 'a')
    const release = holdNextWrite(disk)
    const first = queue.queueSave(view('w1'), 'a')
    await vi.advanceTimersByTimeAsync(0)
    type('w1', 'ab')
    const cmdS = queue.queueSave(view('w1'), 'ab')
    let settled = false
    const settle = queue.settleFileSaves('w2').then(() => {
      settled = true
    })

    release()
    await settle
    expect(settled).toBe(true)
    expect(await Promise.all([first, cmdS])).toEqual(['written', 'written'])
    expect(writtenContents()).toEqual(['a', 'ab'])
    expect(view('w2').isDirty).toBe(false)
  })
})
