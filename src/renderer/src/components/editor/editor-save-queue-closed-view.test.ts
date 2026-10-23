import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { needsSavePromptOnClose } from '@/store/slices/editor/buffers/editor-buffer-close-rule'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import {
  CLOSED_VIEW_PATH,
  closedViewTab,
  closedViewWorktree,
  createClosedViewHarness,
  type ClosedViewHarness
} from './editor-save-closed-view.test-fixture'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

// One file open in two workspaces (one record), autosave off, the saving tab closed mid-write.
describe('editor save queue: the saving view closes mid-write', () => {
  let h: ClosedViewHarness

  beforeEach(() => {
    h = createClosedViewHarness()
    expect(h.recordOf('A')).toBe(h.recordOf('B'))
  })

  afterEach(() => h.dispose())

  it('undoing the saved edit in the other view leaves it dirty, so closing it asks', async () => {
    h.type('A', 'edit')
    h.holdNextWrite()
    const saved = h.queue.queueSave(h.view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    h.closeView('A')
    h.release()
    await expect(saved).resolves.toBe('written')

    expect(h.disk.files.get(CLOSED_VIEW_PATH)).toBe('edit')
    expect(h.view('B').isDirty).toBe(false)
    expect(h.view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
    expect(h.store.getState().editorDrafts.B).toBeUndefined()
    expect(h.loaded.B?.content).toBe('edit')

    // B undoes the saved change: its text now differs from h.disk.
    h.type('B', 'disk')
    expect(h.view('B').isDirty).toBe(true)
    expect(needsSavePromptOnClose(h.store.getState(), 'B')).toBe(true)
    expect(h.disk.files.get(CLOSED_VIEW_PATH)).toBe('edit')
  })

  it('keeps the other view dirty when it typed past the write', async () => {
    h.type('A', 'edit')
    h.holdNextWrite()
    const saved = h.queue.queueSave(h.view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    h.closeView('A')
    h.type('B', 'edit, more')
    h.release()
    await expect(saved).resolves.toBe('written')

    expect(h.view('B').isDirty).toBe(true)
    expect(h.store.getState().editorDrafts.B).toBe('edit, more')
    expect(h.view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
  })

  it('a save queued behind the running one still writes the record through the view left', async () => {
    h.type('A', 'edit')
    h.holdNextWrite()
    const first = h.queue.queueSave(h.view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    h.type('A', 'edit 2')
    const second = h.queue.queueSave(h.view('A'), 'edit 2')
    h.closeView('A')
    h.release()

    await expect(first).resolves.toBe('written')
    await expect(second).resolves.toBe('written')
    expect(h.disk.files.get(CLOSED_VIEW_PATH)).toBe('edit 2')
    expect(h.view('B').isDirty).toBe(false)
    expect(h.view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit 2'))
    expect(h.loaded.B?.content).toBe('edit 2')
  })
  it.each([
    ['a rich markdown view', (): void => h.store.getState().setMarkdownViewMode('B', 'rich')],
    [
      'listed after a read-only view',
      (): void => {
        h.store.setState({ openFiles: [] })
        h.store.setState({
          openFiles: [
            closedViewTab('A', 'wt-1'),
            { ...closedViewTab('log', 'wt-2'), readOnly: true },
            closedViewTab('B', 'wt-2')
          ]
        })
        expect(h.store.getState().editorBufferViews[h.store.getState().editorBufferIdOf.B]).toEqual(
          ['A', 'log', 'B']
        )
      }
    ]
  ])('settles the record when the view left is %s', async (_name, makeB) => {
    makeB()
    h.type('A', 'edit')
    h.holdNextWrite()
    const saved = h.queue.queueSave(h.view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    h.closeView('A')
    h.release()
    await expect(saved).resolves.toBe('written')

    expect(h.view('B').isDirty).toBe(false)
    expect(h.view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
    expect(h.store.getState().editorDrafts.B).toBeUndefined()
  })

  it('a refused write banners the view left', async () => {
    h.type('A', 'edit')
    h.holdNextWrite(true)
    const saved = h.queue.queueSave(h.view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    h.closeView('A')
    h.release()
    await expect(saved).resolves.toBe('blocked-stale')

    expect(h.view('B').externalMutation).toBe('changed')
    expect(h.view('B').isDirty).toBe(true)
    expect(h.store.getState().editorDrafts.B).toBe('edit')
  })

  it('writes through the view left when the writer closes while another record holds the file', async () => {
    // Divergent dirty drafts keep C off the A+B record, but both write the same file.
    h.store.setState({ openFiles: [] })
    h.store.setState({
      worktreesByRepo: {
        'repo-1': [
          closedViewWorktree('wt-1'),
          closedViewWorktree('wt-2'),
          closedViewWorktree('wt-3')
        ]
      },
      openFiles: [
        { ...closedViewTab('A', 'wt-1'), isDirty: true },
        { ...closedViewTab('B', 'wt-2'), isDirty: true },
        { ...closedViewTab('C', 'wt-3'), isDirty: true }
      ],
      editorDrafts: { A: 'mine', B: 'mine', C: 'theirs' }
    })
    expect(h.recordOf('A')).toBe(h.recordOf('B'))
    expect(h.recordOf('C')).not.toBe(h.recordOf('A'))
    h.holdNextWrite()
    const theirs = h.queue.queueSave(h.view('C'), 'theirs', 'overwrite')
    await vi.advanceTimersByTimeAsync(0)
    const mine = h.queue.queueSave(h.view('A'), 'mine', 'overwrite')
    await vi.advanceTimersByTimeAsync(0)
    h.closeView('A')
    h.release()

    await expect(theirs).resolves.toBe('written')
    await expect(mine).resolves.toBe('written')
    expect(h.disk.files.get(CLOSED_VIEW_PATH)).toBe('mine')
    expect(h.view('B').isDirty).toBe(false)
  })
})
