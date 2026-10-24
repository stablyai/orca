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

// The saving view closes mid-write while the record changes shape around it.
describe('editor save queue: closed saving view, record changes', () => {
  let h: ClosedViewHarness

  beforeEach(() => {
    h = createClosedViewHarness()
  })

  afterEach(() => h.dispose())

  // Wrapped: an async function returning the save would wait for it.
  const startHeldSave = async (): Promise<{ saved: Promise<unknown> }> => {
    h.holdNextWrite()
    const saved = h.queue.queueSave(h.view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    return { saved }
  }

  it('settles the views left after the record is re-keyed mid-write', async () => {
    h.type('A', 'edit')
    const { saved } = await startHeldSave()
    const before = h.recordOf('A')
    // Both workspaces move host, so the record's identity key changes; its views carry over.
    h.store.setState({
      worktreesByRepo: {
        'repo-1': [closedViewWorktree('wt-1', 'ssh:box'), closedViewWorktree('wt-2', 'ssh:box')]
      }
    })
    expect(h.recordOf('B')).not.toBe(before)
    expect(h.recordOf('B')).toBe(h.recordOf('A'))
    h.closeView('A')
    h.release()
    await expect(saved).resolves.toBe('written')

    expect(h.view('B').isDirty).toBe(false)
    expect(h.view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
    h.type('B', 'disk')
    expect(h.view('B').isDirty).toBe(true)
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
    // B's next save overwrites as it would had A stayed open, not refused as stale.
    await expect(h.queue.queueSave(h.view('B'), 'theirs')).resolves.toBe('written')
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
