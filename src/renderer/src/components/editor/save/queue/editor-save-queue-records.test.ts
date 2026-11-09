import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createEditorSaveQueue } from './editor-save-queue'
import type { EditorSaveQueue } from './editor-save-queue-contract'
import { __clearSelfWriteRegistryForTests } from '../../external-changes/editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines,
  type FakeEditorDisk
} from '../../autosave/editor-autosave-controller-test-fixture'

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: () => undefined
}))

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

describe('editor save queue: one autosave timer per record across its views', () => {
  let disk: FakeEditorDisk
  let store: ReturnType<typeof createEditorStore>
  let queue: EditorSaveQueue

  // Use the real middleware to join same-file views by identity.
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
})
