// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelPreviewDetach, queuePreviewDetach } from './preview-detach-batch'

describe('preview detach batching', () => {
  const detach = vi.fn(async () => undefined)

  beforeEach(() => {
    vi.useFakeTimers()
    Object.assign(window, { api: { terminalPreview: { detach } } })
  })

  afterEach(async () => {
    // Drain the module-level queue so one test's leftovers never reach the next.
    await vi.advanceTimersByTimeAsync(0)
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('coalesces the detaches of one commit into a single call per surface', async () => {
    for (const ptyId of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      queuePreviewDetach(ptyId, 'grid')
    }
    queuePreviewDetach('p6', 'dialog')
    expect(detach).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)

    expect(detach).toHaveBeenCalledTimes(2)
    expect(detach).toHaveBeenCalledWith(['p1', 'p2', 'p3', 'p4', 'p5'], 'grid')
    expect(detach).toHaveBeenCalledWith(['p6'], 'dialog')
  })

  it('drops a pty whose preview remounted before the batch went out and hands back its surface', async () => {
    queuePreviewDetach('p1', 'surface-a')
    queuePreviewDetach('p2', 'surface-b')
    // A dnd reorder unmounts and remounts the same card within the frame; the
    // remount carries on as the surface main still holds open.
    expect(cancelPreviewDetach('p2')).toBe('surface-b')
    expect(cancelPreviewDetach('p9')).toBeNull()

    await vi.advanceTimersByTimeAsync(0)

    expect(detach).toHaveBeenCalledTimes(1)
    expect(detach).toHaveBeenCalledWith(['p1'], 'surface-a')
  })

  it('sends nothing when every queued pty was cancelled', async () => {
    queuePreviewDetach('p1', 'surface-a')
    cancelPreviewDetach('p1')

    await vi.advanceTimersByTimeAsync(0)

    expect(detach).not.toHaveBeenCalled()
  })

  it('releases both surfaces of one PTY and deduplicates repeated requests', async () => {
    queuePreviewDetach('p1', 'surface-a')
    queuePreviewDetach('p1', 'surface-b')
    queuePreviewDetach('p1', 'surface-a')

    await vi.advanceTimersByTimeAsync(0)

    expect(detach).toHaveBeenCalledTimes(2)
    expect(detach).toHaveBeenCalledWith(['p1'], 'surface-a')
    expect(detach).toHaveBeenCalledWith(['p1'], 'surface-b')
  })

  it('reclaims one pending surface per remount without keeping the other claim', async () => {
    queuePreviewDetach('p1', 'surface-a')
    queuePreviewDetach('p1', 'surface-b')

    expect(cancelPreviewDetach('p1')).toBe('surface-a')
    await vi.advanceTimersByTimeAsync(0)

    expect(detach).toHaveBeenCalledExactlyOnceWith(['p1'], 'surface-b')
    expect(cancelPreviewDetach('p1')).toBeNull()
  })

  it('hands distinct pending surfaces to two same-frame remounts', async () => {
    queuePreviewDetach('p1', 'surface-a')
    queuePreviewDetach('p1', 'surface-b')

    expect(cancelPreviewDetach('p1')).toBe('surface-a')
    expect(cancelPreviewDetach('p1')).toBe('surface-b')
    expect(cancelPreviewDetach('p1')).toBeNull()
    await vi.advanceTimersByTimeAsync(0)

    expect(detach).not.toHaveBeenCalled()
  })
})
