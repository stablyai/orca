import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closedViewTab,
  createClosedViewHarness,
  type ClosedViewHarness
} from './editor-save-closed-view.test-fixture'

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: () => undefined
}))

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
