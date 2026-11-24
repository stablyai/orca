import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  openStreamAndConfirmReady,
  rpcError,
  settle
} from './remote-browser-stream-lifecycle-test-harness'

describe('RemoteBrowserStreamLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies current ready metadata after open and a viewport restart', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    const before = harness.appliedTitles.length
    harness.streams[0].emitReady()
    await settle()
    expect(harness.appliedTitles.slice(before)).toEqual(['Example'])
    harness.setViewportSize({ width: 1400, height: 900 })
    harness.lifecycle.restartForViewport('page-1')
    await settle()
    const beforeRestartReady = harness.appliedTitles.length
    harness.streams.at(-1)!.emitReady()
    await settle()
    expect(harness.appliedTitles.slice(beforeRestartReady)).toEqual(['Example'])
  })

  it('keeps a stream live without applying ready metadata superseded by navigation', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    const before = [...harness.appliedTitles]
    harness.lifecycle.session.invalidateTabInfoReads()
    harness.streams[0].emitReady()
    await settle()
    expect(harness.appliedTitles).toEqual(before)
    expect(harness.currentStatusKind).toBe('live')
  })

  it("asks once about the streamed page's dialog and answers it on the host", async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    const stream = harness.streams[0]

    stream.emitDialog('confirm', 'Proceed?')
    // The host repeats the dialog it still holds when a turned-away nested one closes.
    stream.emitDialog('confirm', 'Proceed?')
    expect(harness.dialogAsks).toHaveLength(1)
    expect(harness.dialogAsks[0].dialog).toEqual({
      type: 'confirm',
      message: 'Proceed?',
      defaultPromptText: '',
      origin: null
    })

    harness.dialogAsks[0].answer({ accept: true, promptText: '' })
    await settle()
    expect(harness.rpcParams('browser.dialogAccept')).toEqual({
      worktree: 'worktree:wt-1',
      page: 'page-1',
      text: ''
    })
  })

  it('drops the ask when the host closes the dialog some other way', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    const stream = harness.streams[0]

    stream.emitDialog('alert', 'Saved')
    stream.emitDialogClosed()
    expect(harness.dialogAsks[0].signal.aborted).toBe(true)

    // The next dialog gets its own ask.
    stream.emitDialog('alert', 'Again')
    expect(harness.dialogAsks).toHaveLength(2)
    harness.dialogAsks[1].answer(null)
    await settle()
    expect(harness.rpcLog).toContain('browser.dialogDismiss')
  })

  // Parked unmount has no effect cleanup left; parking must already have unsubscribed.
  it('leaves nothing subscribed when the pane unmounts while its stream is parked', async () => {
    const harness = createHarness()
    const closeStream = await openStreamAndConfirmReady(harness)

    closeStream()
    const statusWritesWhileParked = harness.statusLog.length

    harness.identity.mounted = false
    harness.lifecycle.dispose()
    harness.streams[0].emitClose()
    harness.streams[0].emitStreamError('too late')
    await vi.advanceTimersByTimeAsync(120_000)

    expect(harness.streams[0].unsubscribeCount).toBe(1)
    expect(harness.statusLog).toHaveLength(statusWritesWhileParked)
    expect(harness.subscribeAttempts).toBe(1)
  })

  // A superseded viewport wait must not steal the live stream token or cancel its ready deadline when it resumes.
  it('drops an attempt superseded while it waited for the viewport', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    const viewport = harness.holdNextViewportSize()
    harness.setViewportSize({ width: 1400, height: 900 })
    harness.lifecycle.restartForViewport('page-1')
    await settle()

    // A reopen (tab switch, environment change, Reconnect) supersedes the blocked resize.
    harness.lifecycle.open()
    await settle()
    const supersedingStream = harness.streams.at(-1)!

    viewport.release()
    await settle()

    // The reopen's own stream must still own the pane: its 'ready' has to land.
    supersedingStream.emitReady()
    await settle()
    expect(harness.currentStatusKind).toBe('live')
  })

  it('restarts at the new size when the pane was resized while its stream was opening', async () => {
    const harness = createHarness()
    const subscribe = harness.holdNextSubscribe()
    harness.lifecycle.open()
    await settle()

    harness.setViewportSize({ width: 1400, height: 900 })
    expect(harness.lifecycle.restartForViewport('page-1')).toBe(false)
    subscribe.release()
    await settle()

    expect(harness.streams.map((stream) => stream.viewportWidth)).toEqual([800, 1400])
    expect(harness.streams[0].unsubscribeCount).toBe(1)
  })

  it('does not clear busy when a superseded viewport restart resolves with no stream', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.setViewportSize({ width: 1200, height: 900 })
    const statusGate = harness.holdNextStatusGet()

    harness.lifecycle.restartForViewport('page-1')
    await settle()

    // The isActive effect re-runs for the same page and bumps the operation generation.
    harness.lifecycle.open()
    await settle()
    harness.streams.at(-1)!.emitReady()
    await settle()
    const busyAfterNewOperation = [...harness.busyLog]

    statusGate.release()
    await settle()

    expect(harness.busyLog).toEqual(busyAfterNewOperation)
  })

  it('does not surface the error of a superseded viewport restart', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.setViewportSize({ width: 1200, height: 900 })
    const statusGate = harness.holdNextStatusGet()

    harness.lifecycle.restartForViewport('page-1')
    await settle()

    harness.lifecycle.open()
    await settle()
    harness.streams.at(-1)!.emitReady()
    await settle()

    statusGate.fail(new Error('stale restart failed'))
    await settle()

    expect(harness.errorLog).not.toContain('stale restart failed')
    expect(harness.currentError).toBeNull()
  })

  it('retires in-flight tab refreshes when a viewport restart supersedes them', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    const refreshToken = harness.lifecycle.tokens.createOperationToken('page-1')!
    const tabShowGate = harness.holdNextTabShow()

    harness.lifecycle.session.scheduleTabInfoRefresh(refreshToken, 100)
    await vi.advanceTimersByTimeAsync(100)
    const titlesBeforeRestart = [...harness.appliedTitles]

    harness.setViewportSize({ width: 1200, height: 900 })
    harness.lifecycle.restartForViewport('page-1')
    tabShowGate.release()
    await settle()

    expect(harness.appliedTitles).toEqual(titlesBeforeRestart)
  })

  // Transport errors retain their token; cancel the ready deadline so it cannot later withdraw Reconnect.
  it('keeps a transport error actionable when the stream never said ready', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    expect(harness.streams).toHaveLength(1)

    harness.streams[0].emitTransportError('runtime_timeout', 'socket hiccup')
    await settle()
    expect(harness.reconnectOffered).toBe(true)

    // Long enough for the ready deadline to have fired.
    await vi.advanceTimersByTimeAsync(120_000)

    expect(harness.currentError).toBe('Lost connection to the remote server.')
    expect(harness.reconnectOffered).toBe(true)
    expect(harness.busyLog.at(-1)).toBe(false)
    expect(harness.subscribeAttempts).toBe(1)
  })

  it('reopens with the same lifecycle after a StrictMode cleanup cycle', async () => {
    const harness = createHarness()
    const closeStream = await openStreamAndConfirmReady(harness)

    harness.identity.mounted = false
    harness.lifecycle.dispose()
    closeStream()
    harness.identity.mounted = true
    harness.lifecycle.open()
    await settle()

    expect(harness.streams).toHaveLength(2)
    harness.streams[1].emitReady()
    await settle()
    expect(harness.currentStatusKind).toBe('live')
  })

  it('keeps the replacement ready deadline when a superseded subscribe rejects late', async () => {
    const harness = createHarness()
    const staleSubscribe = harness.holdNextSubscribe()
    const closeStaleOpen = harness.lifecycle.open()
    await settle()

    closeStaleOpen()
    harness.lifecycle.open()
    await settle()
    expect(harness.streams).toHaveLength(1)

    staleSubscribe.fail(rpcError('runtime_unavailable', 'stale subscribe failed'))
    await settle()
    await vi.advanceTimersByTimeAsync(400_000)

    expect(harness.reconnectOffered).toBe(true)
  })
})

describe('RemoteBrowserStreamLifecycle reconnect affordance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not carry a spent offer into the next open', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('runtime_unavailable', 'socket died'))
    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.reconnectOffered).toBe(true)

    // Assert before ready so only open() can have cleared exhaustion.
    harness.failEverySubscribe(null)
    harness.lifecycle.open()
    await settle()
    expect(harness.reconnectOffered).toBe(false)
  })
})

// Streams may end before ready without throwing; exhaustion must still publish a notice and usable Reconnect.
describe('RemoteBrowserStreamLifecycle silent budget drain', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a failure when the budget drains without any attempt throwing', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    for (let round = 0; round < 6; round++) {
      harness.streams.at(-1)!.emitEnd()
      await vi.advanceTimersByTimeAsync(20_000)
    }

    expect(harness.reconnectOffered).toBe(true)
    // Without a message the button cannot render at all.
    expect(harness.currentError).not.toBeNull()
    // A spinner left running over a frozen frame also blocks the pane's input handlers.
    expect(harness.busyLog.at(-1)).toBe(false)
  })
})

// Socket failure can deliver error then close; close must replace the temporary stop with automatic recovery. Manual-disconnect E2E covers only close.
describe('RemoteBrowserStreamLifecycle transport error', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Cancelling the ready deadline must retain uptime so a following close can refill a healthy stream’s retry budget.
  it('still refills the budget when a close follows a transport error on a healthy stream', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    // Spend one budget step: a drop whose retry succeeds.
    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    harness.streams[1].emitReady()
    await settle()

    // Let the replacement prove itself — longer than the window that earns a refill.
    await vi.advanceTimersByTimeAsync(15_000)

    harness.streams[1].emitTransportError('runtime_timeout', 'socket hiccup')
    await settle()
    harness.failEverySubscribe(rpcError('runtime_unavailable', 'still down'))
    harness.streams[1].emitClose()
    await settle()
    const attemptsAfterClose = harness.subscribeAttempts

    await vi.advanceTimersByTimeAsync(120_000)

    // A full ladder, not the tail of the earlier one.
    expect(harness.subscribeAttempts - attemptsAfterClose).toBe(5)
    expect(harness.reconnectOffered).toBe(true)
  })

  // Once close starts automatic recovery, hide manual Reconnect until that budget is exhausted.
  it('withdraws the offer once the close starts the retry budget', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.streams[0].emitTransportError('runtime_unavailable', 'socket reset by peer')
    await settle()
    expect(harness.reconnectOffered).toBe(true)

    harness.failEverySubscribe(rpcError('runtime_unavailable', 'still down'))
    harness.streams[0].emitClose()
    await settle()
    expect(harness.reconnectOffered).toBe(false)

    await vi.advanceTimersByTimeAsync(600)
    expect(harness.reconnectOffered).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.reconnectOffered).toBe(true)
  })
})

// The host can close before subscribe rejects; the armed restart then owns status over the older rejection.
describe('RemoteBrowserStreamLifecycle close racing a rejected subscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not offer reconnect over a restart that is already armed', async () => {
    const harness = createHarness()
    harness.closeThenRejectNextSubscribe()
    harness.lifecycle.open()
    await settle()

    // An older rejection must not briefly show manual Reconnect while automatic recovery owns the pane.
    expect(harness.reconnectOffered).toBe(false)
    expect(harness.busyLog.at(-1)).toBe(true)
    expect(harness.currentError).toBeNull()
  })
})

// Subscribe resolves when sent; a silent host still needs a ready deadline or the pane stays busy without recovery.
describe('RemoteBrowserStreamLifecycle host that never says ready', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not sit busy forever when the host accepts the subscribe and goes silent', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    expect(harness.streams).toHaveLength(1)

    // Nothing has failed yet, so the pane is right to still be working.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(harness.reconnectOffered).toBe(false)
    expect(harness.busyLog.at(-1)).toBe(true)

    await vi.advanceTimersByTimeAsync(400_000)

    expect(harness.reconnectOffered).toBe(true)
    expect(harness.busyLog.at(-1)).toBe(false)
    expect(harness.currentError).not.toBeNull()
  })

  it('releases the hung subscription rather than leaking it', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()

    await vi.advanceTimersByTimeAsync(400_000)

    expect(harness.streams[0].unsubscribeCount).toBeGreaterThan(0)
  })
})

// CDP subscribers evict one another; ready alone must not refill the budget and permit endless flapping.
describe('RemoteBrowserStreamLifecycle flapping host', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops a host that flaps ready-then-end instead of retrying forever', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    for (let round = 0; round < 8; round++) {
      harness.streams.at(-1)!.emitEnd()
      // Allow backoff to fire without earning a healthy-stream refill.
      await vi.advanceTimersByTimeAsync(9_000)
      harness.streams.at(-1)!.emitReady()
      await settle()
    }

    expect(harness.reconnectOffered).toBe(true)
    expect(harness.busyLog.at(-1)).toBe(false)
  })
})
