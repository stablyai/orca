import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { createEditorSaveQueue, type EditorSaveQueue } from './editor-save-queue'
import { createEditorRestartSaveHandlers } from './editor-restart-save-handlers'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { bumpEditorDiscardEpoch } from './editor-discard-epoch'
import { isDetachedEditorBufferId } from '@/store/slices/editor/buffers/editor-buffer-views'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const PATH = '/repo/a.ts'
const DELAY_MS = 1000
const WORKTREES = {
  'repo-1': [
    makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
    makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
  ]
}

// A view opened before a reconnect: its captured connection generation no longer matches.
const STALE_PROVENANCE: EditorFileOperationProvenance = {
  ownershipProjection: 'explicit',
  expectedSshConnectionGeneration: 7,
  generation: {
    route: { executionHostId: 'local', runtimeEnvironmentId: null },
    runtimeConnectionGeneration: null,
    runtimePairingRevision: undefined,
    runtimeSshGeneration: null,
    nestedSshGeneration: null,
    directSshGeneration: null
  }
}

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: PATH,
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: getDiskBaselineSignature('disk'),
    ...patch
  }
}

describe('editor save queue: shared records', () => {
  let disk: FakeEditorDisk
  let store: ReturnType<typeof createEditorStore>
  let queue: EditorSaveQueue

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
  const recordOf = (id: string): string => store.getState().editorBufferIdOf[id]
  const writes = (): string[] => disk.fs.writeFile.mock.calls.map(([args]) => args.content)

  beforeEach(() => {
    vi.useFakeTimers()
    disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: 'disk' }))
    store = createEditorStore()
    store.setState({ worktreesByRepo: WORKTREES })
    queue = createEditorSaveQueue(store)
  })

  afterEach(() => {
    queue.dispose()
    __clearSelfWriteRegistryForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("a save queued on a detached record keeps that record's discard epoch after a rejoin", async () => {
    // Divergent restored drafts keep w2 detached from w1’s record.
    store.setState({
      openFiles: [tab('w1', { isDirty: true }), tab('w2', { worktreeId: 'wt-2', isDirty: true })],
      editorDrafts: { w1: 'mine', w2: 'theirs' }
    })
    expect(isDetachedEditorBufferId(recordOf('w2'))).toBe(true)
    // Only w1’s record has previously been discarded.
    bumpEditorDiscardEpoch(recordOf('w1'))
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
    const first = queue.queueSave(view('w2'), 'theirs')
    await vi.advanceTimersByTimeAsync(0)
    const second = queue.queueSave(view('w2'), 'theirs')
    // Rejoin before dispatch to verify the queued request retains its original record’s discard epoch.
    store.getState().markFileDirty('w1', false)
    store.getState().clearEditorDraft('w1')
    await vi.advanceTimersByTimeAsync(0)
    expect(recordOf('w2')).toBe(recordOf('w1'))
    store.getState().setEditorDraft('w2', 'theirs, more')
    store.getState().markFileDirty('w2', true)

    release()
    await expect(first).resolves.toBe('written')
    await expect(second).resolves.toBe('written')
    expect(writes()).toEqual(['theirs', 'theirs, more'])
  })

  describe('a read-only sibling joining a dirty record', () => {
    it('mirrors the edits, and autosave writes once through the writable view', async () => {
      store.setState({ openFiles: [tab('w1')] })
      type('w1', 'edits')
      // Listed first, so a per-tab pick would choose it.
      store.setState((s) => ({ openFiles: [tab('log', { readOnly: true }), ...s.openFiles] }))
      queue.syncAutoSave()

      expect(recordOf('log')).toBe(recordOf('w1'))
      expect(view('log').isDirty).toBe(true)
      expect(store.getState().editorDrafts.log).toBe('edits')
      await vi.advanceTimersByTimeAsync(DELAY_MS)

      expect(writes()).toEqual(['edits'])
      expect(view('log').isDirty).toBe(false)
      expect(view('w1').isDirty).toBe(false)
    })

    it('never autosaves a record whose only view left is read-only', async () => {
      store.setState({ openFiles: [tab('w1'), tab('log', { readOnly: true })] })
      type('w1', 'edits')
      store.setState((s) => ({ openFiles: s.openFiles.filter((file) => file.id !== 'w1') }))
      queue.syncAutoSave()
      await vi.advanceTimersByTimeAsync(DELAY_MS * 3)

      expect(writes()).toEqual([])
      expect(view('log').isDirty).toBe(true)
      expect(store.getState().editorDrafts.log).toBe('edits')
    })
  })

  describe('restart save', () => {
    const restart = async (): Promise<{ resolved: boolean; rejected?: string }> => {
      const { handleSaveDirtyFiles } = createEditorRestartSaveHandlers({
        store,
        queueSave: queue.queueSave,
        settleFileSaves: queue.settleFileSaves
      })
      const outcome: { resolved: boolean; rejected?: string } = { resolved: false }
      const detail = {
        claim: () => {},
        resolve: () => {
          outcome.resolved = true
        },
        reject: (message: string) => {
          outcome.rejected = message
        }
      }
      await handleSaveDirtyFiles(new CustomEvent('restart', { detail }))
      return outcome
    }

    it('writes each record once, whichever workspace holds its views', async () => {
      store.setState({
        openFiles: [
          tab('w1'),
          tab('w2', { worktreeId: 'wt-2' }),
          tab('b1', { filePath: '/repo/b.ts', relativePath: 'b.ts' }),
          tab('b2', { filePath: '/repo/b.ts', relativePath: 'b.ts', worktreeId: 'wt-2' })
        ]
      })
      disk.files.set('/repo/b.ts', 'disk')
      type('w2', 'a edits')
      type('b1', 'b edits')

      expect(await restart()).toEqual({ resolved: true })
      expect(disk.fs.writeFile).toHaveBeenCalledTimes(2)
      expect(disk.files.get(PATH)).toBe('a edits')
      expect(disk.files.get('/repo/b.ts')).toBe('b edits')
      expect(store.getState().openFiles.every((file) => !file.isDirty)).toBe(true)
    })

    it('writes through the writable view when a read-only view of the record is listed first', async () => {
      store.setState({ openFiles: [tab('log', { readOnly: true }), tab('w1')] })
      type('w1', 'edits')

      expect(await restart()).toEqual({ resolved: true })
      expect(writes()).toEqual(['edits'])
    })
  })

  describe('the reconnect writer', () => {
    it('autosave writes through the view on the current connection', async () => {
      store.setState({
        openFiles: [tab('old', { operationProvenance: STALE_PROVENANCE }), tab('new')]
      })
      expect(recordOf('old')).toBe(recordOf('new'))
      type('old', 'edits')
      await vi.advanceTimersByTimeAsync(DELAY_MS)

      expect(writes()).toEqual(['edits'])
      expect(view('old').isDirty).toBe(false)
      expect(view('new').isDirty).toBe(false)
    })

    it('a record left with only a stale-connection view skips autosave quietly', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      store.setState({ openFiles: [tab('old', { operationProvenance: STALE_PROVENANCE })] })
      type('old', 'edits')
      await vi.advanceTimersByTimeAsync(DELAY_MS)
      expect(await queue.queueSave(view('old'), 'edits', 'autosave')).toBe('failed')

      expect(writes()).toEqual([])
      expect(logged).not.toHaveBeenCalled()
      expect(view('old').isDirty).toBe(true)
      expect(view('old').externalMutation).toBeUndefined()
      expect(store.getState().editorDrafts.old).toBe('edits')

      store.setState((s) => ({ openFiles: [...s.openFiles, tab('new', { worktreeId: 'wt-2' })] }))
      queue.syncAutoSave()
      await vi.advanceTimersByTimeAsync(DELAY_MS)
      expect(writes()).toEqual(['edits'])
      expect(view('old').isDirty).toBe(false)
    })
  })

  describe('re-keys carry the record', () => {
    it('a rename carries a conflict onto the clean record at the new path', async () => {
      disk.files.set('/repo/old.ts', 'disk')
      store.setState({
        openFiles: [tab('old', { filePath: '/repo/old.ts', relativePath: 'old.ts' }), tab('w2')]
      })
      type('old', 'edits')
      store.getState().setExternalMutation('old', 'changed')

      const result = store.getState().rekeyOpenFilesForPathChange({
        rekeys: [
          {
            oldFileId: 'old',
            newFileId: 'renamed',
            oldFilePath: '/repo/old.ts',
            newFilePath: PATH,
            newRelativePath: 'a.ts'
          }
        ]
      })
      queue.syncAutoSave()

      expect(result).toEqual({ ok: true })
      expect(recordOf('renamed')).toBe(recordOf('w2'))
      for (const id of ['renamed', 'w2']) {
        expect(view(id).externalMutation).toBe('changed')
        expect(view(id).isDirty).toBe(true)
        expect(store.getState().editorDrafts[id]).toBe('edits')
      }
      await vi.advanceTimersByTimeAsync(DELAY_MS * 2)
      expect(writes()).toEqual([])

      store.getState().setExternalMutation('w2', null)
      queue.syncAutoSave()
      await vi.advanceTimersByTimeAsync(DELAY_MS)
      expect(writes()).toEqual(['edits'])
    })

    it('a stale baseline carried by a rename is refused and bannered on every view', async () => {
      disk.files.set('/repo/old.ts', 'disk')
      disk.files.set(PATH, 'someone else')
      store.setState({
        openFiles: [
          tab('old', { filePath: '/repo/old.ts', relativePath: 'old.ts' }),
          tab('w2', { lastKnownDiskSignature: getDiskBaselineSignature('someone else') })
        ]
      })
      type('old', 'edits')
      store.getState().rekeyOpenFilesForPathChange({
        rekeys: [
          {
            oldFileId: 'old',
            newFileId: 'renamed',
            oldFilePath: '/repo/old.ts',
            newFilePath: PATH,
            newRelativePath: 'a.ts'
          }
        ]
      })

      expect(await queue.queueSave(view('renamed'), 'edits', 'autosave')).toBe('blocked-stale')
      expect(disk.files.get(PATH)).toBe('someone else')
      expect(view('renamed').externalMutation).toBe('changed')
      expect(view('w2').externalMutation).toBe('changed')
      expect(view('w2').isDirty).toBe(true)
    })

    it('owner resolution re-keys a record by route inputs alone, keeping its conflict', async () => {
      store.setState({ worktreesByRepo: {} })
      store.setState({ openFiles: [tab('w1'), tab('w2', { worktreeId: 'wt-2' })] })
      // Unresolved owners never share.
      expect(recordOf('w1')).not.toBe(recordOf('w2'))
      type('w1', 'edits')
      store.getState().setExternalMutation('w1', 'changed')
      const openFilesBefore = store.getState().openFiles

      store.setState({ worktreesByRepo: WORKTREES })
      queue.syncAutoSave()

      const state = store.getState()
      expect(recordOf('w1')).toBe(recordOf('w2'))
      expect(recordOf('w1')).not.toBe('w1')
      expect(Object.keys(state.editorBuffers)).toEqual([recordOf('w1')])
      expect(state.openFiles.map((file) => file.id)).toEqual(openFilesBefore.map((f) => f.id))
      expect(view('w1')).toBe(openFilesBefore[0])
      for (const id of ['w1', 'w2']) {
        expect(view(id).externalMutation).toBe('changed')
        expect(view(id).isDirty).toBe(true)
        expect(state.editorDrafts[id]).toBe('edits')
      }
      await vi.advanceTimersByTimeAsync(DELAY_MS * 2)
      expect(writes()).toEqual([])

      store.getState().setExternalMutation('w2', null)
      queue.syncAutoSave()
      await vi.advanceTimersByTimeAsync(DELAY_MS)
      expect(writes()).toEqual(['edits'])
    })
  })
})
