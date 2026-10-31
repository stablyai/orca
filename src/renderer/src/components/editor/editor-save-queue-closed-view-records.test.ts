import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import {
  CLOSED_VIEW_PATH,
  closedViewTab,
  closedViewWorktree,
  createClosedViewHarness,
  type ClosedViewHarness
} from './editor-save-closed-view.test-fixture'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

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

describe('editor save queue: closed saving view, record changes', () => {
  let h: ClosedViewHarness

  beforeEach(() => {
    h = createClosedViewHarness()
  })

  afterEach(() => h.dispose())

  // Wrap the save promise so this async function does not await the held write.
  const startHeldSave = async (): Promise<{ saved: Promise<unknown> }> => {
    h.holdNextWrite()
    const saved = h.queue.queueSave(h.view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    return { saved }
  }

  it('does not settle a different host after the record is re-keyed mid-write', async () => {
    h.type('A', 'edit')
    const { saved } = await startHeldSave()
    const before = h.recordOf('A')
    // Changing both workspace hosts rekeys the record while retaining its views.
    h.store.setState({
      worktreesByRepo: {
        'repo-1': [closedViewWorktree('wt-1', 'ssh:box'), closedViewWorktree('wt-2', 'ssh:box')]
      }
    })
    expect(h.recordOf('B')).not.toBe(before)
    expect(h.recordOf('B')).not.toBe(h.recordOf('A'))
    h.closeView('A')
    h.release()
    await expect(saved).resolves.toBe('written')

    expect(h.view('B').isDirty).toBe(true)
    expect(h.store.getState().editorDrafts.B).toBe('edit')
    expect(h.view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('disk'))
  })

  it('a queued save skips a stale-connection view for a current one', async () => {
    h.store.setState({ openFiles: [] })
    h.store.setState({
      openFiles: [
        closedViewTab('A', 'wt-1'),
        { ...closedViewTab('old', 'wt-2'), operationProvenance: STALE_PROVENANCE },
        closedViewTab('B', 'wt-2')
      ]
    })
    h.type('A', 'edit')
    const { saved: first } = await startHeldSave()
    h.type('A', 'edit 2')
    const second = h.queue.queueSave(h.view('A'), 'edit 2')
    h.closeView('A')
    h.release()

    await expect(first).resolves.toBe('written')
    await expect(second).resolves.toBe('written')
    expect(h.disk.files.get(CLOSED_VIEW_PATH)).toBe('edit 2')
    expect(h.view('B').isDirty).toBe(false)
  })

  it("moves a detached peer's baseline to the write, keeping its edits", async () => {
    h.store.setState({ openFiles: [] })
    h.store.setState({
      openFiles: [
        { ...closedViewTab('A', 'wt-1'), isDirty: true },
        { ...closedViewTab('B', 'wt-2'), isDirty: true }
      ],
      editorDrafts: { A: 'edit', B: 'theirs' }
    })
    expect(h.recordOf('B')).not.toBe(h.recordOf('A'))
    const { saved } = await startHeldSave()
    h.closeView('A')
    h.release()
    await expect(saved).resolves.toBe('written')

    expect(h.view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
    expect(h.view('B').isDirty).toBe(true)
    expect(h.store.getState().editorDrafts.B).toBe('theirs')
    await expect(h.queue.queueSave(h.view('B'), 'theirs')).resolves.toBe('written')
  })

  it('settles a kept detached record without dropping a divergent live record', async () => {
    h.store.setState({ openFiles: [] })
    h.store.setState({
      openFiles: [
        { ...closedViewTab('A', 'wt-1'), isDirty: true },
        { ...closedViewTab('B', 'wt-2'), isDirty: true }
      ],
      editorDrafts: { A: 'theirs', B: 'mine' }
    })
    const detached = h.recordOf('B')
    expect(detached).not.toBe(h.recordOf('A'))
    h.holdNextWrite()
    const saved = h.queue.queueSave(h.view('B'), 'mine')
    await vi.advanceTimersByTimeAsync(0)
    h.store.setState((state) => ({
      openFiles: state.openFiles.filter((file) => file.id !== 'B'),
      editorBufferKeepRequest: { viewIds: new Set(['B']), notice: 2 }
    }))
    expect(h.store.getState().editorBufferKept[detached]?.draft).toBe('mine')
    h.release()
    await expect(saved).resolves.toBe('written')
    expect(h.store.getState().editorBufferKept[detached]).toBeUndefined()
    expect(h.view('A').isDirty).toBe(true)
    expect(h.store.getState().editorDrafts.A).toBe('theirs')
    expect(h.view('A').lastKnownDiskSignature).toBe(getDiskBaselineSignature('mine'))
  })

  it.each(['mine, more', 'mine'])(
    'keeps the latest retained detached draft %s until the write settles',
    async (draft) => {
      h.store.setState({ openFiles: [] })
      h.store.setState({
        openFiles: [
          { ...closedViewTab('A', 'wt-1'), isDirty: true },
          { ...closedViewTab('B', 'wt-2'), isDirty: true }
        ],
        editorDrafts: { A: 'theirs', B: 'mine' }
      })
      const detached = h.recordOf('B')
      h.holdNextWrite()
      const saved = h.queue.queueSave(h.view('B'), 'mine')
      await vi.advanceTimersByTimeAsync(0)
      h.type('B', draft)
      h.store.setState((state) => ({
        openFiles: state.openFiles.filter((file) => file.id !== 'B'),
        editorBufferKeepRequest: { viewIds: new Set(['B']), notice: 2 }
      }))
      const kept = h.store.getState().editorBufferKept[detached]
      expect(kept?.draft).toBe(draft)
      expect(kept?.resourceKey).toBeTruthy()
      h.release()
      await expect(saved).resolves.toBe('written')
      if (draft === 'mine') {
        expect(h.store.getState().editorBufferKept[detached]).toBeUndefined()
      } else {
        expect(h.store.getState().editorBufferKept[detached]).toMatchObject({
          notice: 2,
          draft,
          resourceKey: kept?.resourceKey,
          record: { isDirty: true, lastKnownDiskSignature: getDiskBaselineSignature('mine') }
        })
      }
      expect(h.store.getState().editorDrafts.A).toBe('theirs')
    }
  )

  it('does not settle a reused detached record belonging to a different file', async () => {
    h.store.setState({ openFiles: [] })
    h.store.setState({
      openFiles: [
        { ...closedViewTab('A', 'wt-1'), isDirty: true },
        { ...closedViewTab('B', 'wt-2'), isDirty: true }
      ],
      editorDrafts: { A: 'theirs', B: 'mine' }
    })
    const detached = h.recordOf('B')
    h.holdNextWrite()
    const saved = h.queue.queueSave(h.view('B'), 'mine')
    await vi.advanceTimersByTimeAsync(0)
    h.closeView('B')
    const foreign = {
      ...closedViewTab('B', 'wt-2'),
      filePath: '/repo/foreign.md',
      relativePath: 'foreign.md',
      isDirty: true
    }
    h.store.setState((state) => ({
      openFiles: [...state.openFiles, { ...foreign, id: 'C' }, foreign],
      editorDrafts: { ...state.editorDrafts, B: 'foreign draft', C: 'foreign peer' }
    }))
    expect(h.recordOf('B')).toBe(detached)
    h.store.setState((state) => ({
      openFiles: state.openFiles.filter((file) => file.id !== 'B'),
      editorBufferKeepRequest: { viewIds: new Set(['B']), notice: 3 }
    }))
    const kept = h.store.getState().editorBufferKept[detached]
    expect(kept?.draft).toBe('foreign draft')
    h.release()
    await expect(saved).resolves.toBe('written')
    expect(h.store.getState().editorBufferKept[detached]).toEqual(kept)
    expect(h.view('C').lastKnownDiskSignature).toBe(getDiskBaselineSignature('disk'))
    expect(h.store.getState().editorDrafts.C).toBe('foreign peer')
  })

  it('joins a retained record when the file reopens before its issued write completes', async () => {
    h.type('A', 'edit')
    const { saved } = await startHeldSave()
    h.store.setState({
      openFiles: [],
      editorBufferKeepRequest: { viewIds: new Set(['A', 'B']), notice: 1 }
    })
    h.store.setState({ openFiles: [closedViewTab('return', 'wt-2')] })
    expect(h.store.getState().editorDrafts.return).toBe('edit')
    h.release()
    await expect(saved).resolves.toBe('written')
    expect(h.view('return').isDirty).toBe(false)
    expect(h.store.getState().editorDrafts.return).toBeUndefined()
    expect(h.view('return').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
    expect(h.store.getState().editorBufferKept).toEqual({})
  })

  it('drops a kept record whose text the write saved', async () => {
    h.type('A', 'edit')
    const { saved } = await startHeldSave()
    // A no-prompt removal closes both views and keeps the dirty record.
    h.store.setState({
      openFiles: [],
      editorBufferKeepRequest: { viewIds: new Set(['A', 'B']), notice: 1 }
    })
    expect(Object.keys(h.store.getState().editorBufferKept)).toHaveLength(1)
    h.release()
    await expect(saved).resolves.toBe('written')

    expect(h.store.getState().editorBufferKept).toEqual({})
  })

  it('marks the record clean when only a read-only view is left', async () => {
    h.store.setState({ openFiles: [] })
    h.store.setState({
      openFiles: [closedViewTab('A', 'wt-1'), { ...closedViewTab('log', 'wt-2'), readOnly: true }]
    })
    h.type('A', 'edit')
    expect(h.view('log').isDirty).toBe(true)
    const { saved } = await startHeldSave()
    h.closeView('A')
    h.release()
    await expect(saved).resolves.toBe('written')

    expect(h.view('log').isDirty).toBe(false)
    expect(h.store.getState().editorDrafts.log).toBeUndefined()
  })

  it('a read-only view still never becomes dirty', () => {
    h.store.setState({ openFiles: [] })
    h.store.setState({ openFiles: [{ ...closedViewTab('log', 'wt-1'), readOnly: true }] })
    h.store.getState().markFileDirty('log', true, { written: true })
    expect(h.view('log').isDirty).toBe(false)
  })
})
