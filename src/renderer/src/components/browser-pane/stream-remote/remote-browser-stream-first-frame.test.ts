import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  openStreamAndConfirmReady,
  settle
} from './remote-browser-stream-lifecycle-test-harness'

describe('RemoteBrowserStreamLifecycle first frame', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for visible proof and nudges one first frame from an old host', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()

    harness.streams[0].emitReady()
    await settle()

    expect(harness.currentStatusKind).toBe('opening')
    expect(harness.handledFrames).toBe(0)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(harness.rpcLog.filter((method) => method === 'browser.eval')).toHaveLength(1)

    harness.streams[0].emitFrame()
    await settle()

    expect(harness.currentStatusKind).toBe('live')
    expect(harness.handledFrames).toBe(1)
  })

  it('restarts a stream that stays frame-less after the repaint', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()

    await vi.advanceTimersByTimeAsync(5_000)

    expect(harness.streams).toHaveLength(2)
    expect(harness.streams[0].unsubscribeCount).toBe(1)
    expect(harness.currentStatusKind).toBe('retrying')
  })

  it('offers reconnect when every accepted stream stays frame-less', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()

    for (let round = 0; round < 6; round++) {
      harness.streams.at(-1)!.emitReady()
      await vi.advanceTimersByTimeAsync(20_000)
    }

    expect(harness.reconnectOffered).toBe(true)
    expect(harness.busyLog.at(-1)).toBe(false)
    expect(harness.currentError).not.toBeNull()
    expect(harness.subscribeAttempts).toBe(6)
    expect(harness.streams).toHaveLength(6)
    expect(harness.streams.map((stream) => stream.unsubscribeCount)).toEqual([1, 1, 1, 1, 1, 1])
    expect(harness.rpcLog.filter((method) => method === 'browser.eval')).toHaveLength(6)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(harness.subscribeAttempts).toBe(6)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let a stale frame prove the replacement stream live', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()

    harness.setViewportSize({ width: 1200, height: 900 })
    harness.lifecycle.restartForViewport('page-1')
    await settle()

    harness.streams[0].emitFrame()
    harness.streams[1].emitReady()
    await settle()

    expect(harness.handledFrames).toBe(0)
    expect(harness.currentStatusKind).toBe('opening')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(harness.rpcLog.filter((method) => method === 'browser.eval')).toHaveLength(1)
  })

  it('ignores ready and frame events after a transport failure', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    const appliedBefore = harness.appliedTitles.length
    const syncedBefore = harness.syncedViewportSizes.length

    harness.streams[0].emitTransportError('runtime_timeout', 'socket failed')
    harness.streams[0].emitReady()
    harness.streams[0].emitFrame()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.currentStatusKind).toBe('stopped')
    expect(harness.handledFrames).toBe(0)
    expect(harness.appliedTitles).toHaveLength(appliedBefore)
    expect(harness.syncedViewportSizes).toHaveLength(syncedBefore)
    expect(harness.rpcLog).not.toContain('browser.eval')
  })

  it('treats duplicate ready acknowledgements as idempotent', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()
    const appliedAfterReady = harness.appliedTitles.length
    const syncedAfterReady = harness.syncedViewportSizes.length

    await vi.advanceTimersByTimeAsync(1_000)
    harness.streams[0].emitReady()
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.appliedTitles).toHaveLength(appliedAfterReady)
    expect(harness.syncedViewportSizes).toHaveLength(syncedAfterReady)
    expect(harness.rpcLog.filter((method) => method === 'browser.eval')).toHaveLength(1)
  })

  it.each(['close', 'frame', 'unmount'] as const)(
    'aborts an in-flight repaint on %s',
    async (action) => {
      const harness = createHarness()
      const repaint = harness.holdNextRecoveryEval()
      const close = harness.lifecycle.open()
      await settle()
      harness.streams[0].emitReady()
      await vi.advanceTimersByTimeAsync(1_500)

      if (action === 'close') {
        close()
      } else if (action === 'frame') {
        harness.streams[0].emitFrame()
      } else {
        harness.identity.mounted = false
        harness.lifecycle.dispose()
      }
      await settle()

      expect(harness.recoveryEvalSignal?.aborted).toBe(true)
      expect(harness.recoveryEvalAbortCount).toBe(1)
      repaint.release()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.subscribeAttempts).toBe(1)
    }
  )

  it('aborts an in-flight repaint when a replacement stream takes ownership', async () => {
    const harness = createHarness()
    const repaint = harness.holdNextRecoveryEval()
    harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()
    await vi.advanceTimersByTimeAsync(1_500)

    harness.setViewportSize({ width: 1200, height: 900 })
    harness.lifecycle.restartForViewport('page-1')
    await settle()

    expect(harness.recoveryEvalSignal?.aborted).toBe(true)
    expect(harness.recoveryEvalAbortCount).toBe(1)
    expect(harness.subscribeAttempts).toBe(2)
    repaint.release()
    harness.streams[1].emitReady()
    harness.streams[1].emitFrame()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.currentStatusKind).toBe('live')
    expect(harness.subscribeAttempts).toBe(2)
  })

  it('aborts an in-flight repaint on transport failure', async () => {
    const harness = createHarness()
    const repaint = harness.holdNextRecoveryEval()
    harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()
    await vi.advanceTimersByTimeAsync(1_500)

    harness.streams[0].emitTransportError('runtime_unavailable', 'socket failed')
    await settle()

    expect(harness.recoveryEvalSignal?.aborted).toBe(true)
    expect(harness.recoveryEvalAbortCount).toBe(1)
    repaint.release()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.currentStatusKind).toBe('stopped')
    expect(harness.subscribeAttempts).toBe(1)
  })

  it('cancels first-frame recovery when the pane closes', async () => {
    const harness = createHarness()
    const close = harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()

    close()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.rpcLog).not.toContain('browser.eval')
    expect(harness.streams[0].unsubscribeCount).toBe(1)
  })

  it('publishes live only for the first frame', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    const statusWrites = harness.statusLog.length

    harness.streams[0].emitFrame()
    harness.streams[0].emitFrame()
    await settle()

    expect(harness.statusLog).toHaveLength(statusWrites)
    expect(harness.handledFrames).toBe(3)
  })

  it('does not revive a stopped stream from a late first frame', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()
    harness.streams[0].emitTransportError('runtime_unavailable', 'socket failed')

    harness.streams[0].emitFrame()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.currentStatusKind).toBe('stopped')
    expect(harness.rpcLog).not.toContain('browser.eval')
  })
})
