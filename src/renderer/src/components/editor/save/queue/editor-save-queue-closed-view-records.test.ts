import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'
import {
  closedViewTab,
  closedViewWorktree,
  createClosedViewHarness,
  type ClosedViewHarness
} from './editor-save-closed-view.test-fixture'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

// A view opened before a reconnect: its captured connection generation no longer matches.

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
})
