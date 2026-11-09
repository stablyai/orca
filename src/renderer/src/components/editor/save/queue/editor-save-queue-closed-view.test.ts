import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_VIEW_PATH,
  closedViewTab,
  closedViewWorktree,
  createClosedViewHarness,
  type ClosedViewHarness
} from './editor-save-closed-view.test-fixture'

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: () => undefined
}))

describe('editor save queue: the saving view closes mid-write', () => {
  let h: ClosedViewHarness

  beforeEach(() => {
    h = createClosedViewHarness()
    expect(h.recordOf('A')).toBe(h.recordOf('B'))
  })

  afterEach(() => h.dispose())

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
