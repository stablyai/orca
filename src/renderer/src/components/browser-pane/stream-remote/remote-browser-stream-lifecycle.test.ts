import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  openStreamAndConfirmReady,
  rpcError,
  settle
} from './remote-browser-stream-lifecycle-test-harness'
import { isBrowserPaneUiRuntimeRpcParams } from '../../../../../shared/runtime-rpc-feature-interaction-source'

describe('RemoteBrowserStreamLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens a stream for the pane and reports it live', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    expect(harness.streams).toHaveLength(1)
    expect(harness.streams[0].pageId).toBe('page-1')
    expect(harness.busyLog.at(-1)).toBe(false)
  })

  it('keeps a same-page release target valid across a stream restart', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    const token = harness.lifecycle.tokens.createOperationToken('page-1')
    expect(token).not.toBeNull()

    harness.lifecycle.tokens.supersedeOperations()

    expect(harness.lifecycle.tokens.isCurrentPageTarget(token!)).toBe(true)
    harness.lifecycle.tokens.setRemotePage('page-2')
    expect(harness.lifecycle.tokens.isCurrentPageTarget(token!)).toBe(false)
  })

  it('tags the screencast request as browser-pane UI traffic', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    expect(isBrowserPaneUiRuntimeRpcParams(harness.streams[0].params)).toBe(true)
  })

  it('unsubscribes the live stream when the pane closes it', async () => {
    const harness = createHarness()
    const close = await openStreamAndConfirmReady(harness)

    close()

    expect(harness.streams[0].unsubscribeCount).toBe(1)
  })

  it('reopens the existing remote page after its stream is parked', async () => {
    const harness = createHarness()
    const close = await openStreamAndConfirmReady(harness)

    close()
    expect(harness.streams[0].unsubscribeCount).toBe(1)
    harness.lifecycle.open()
    await settle()
    harness.streams[1].emitReady()
    harness.streams[1].emitFrame()
    await settle()

    expect(harness.streams.map((stream) => stream.pageId)).toEqual(['page-1', 'page-1'])
    expect(harness.rpcLog.filter((method) => method === 'browser.tabCreate')).toHaveLength(1)
    expect(harness.currentStatusKind).toBe('live')
  })

  it('shares one authoritative page when navigation overlaps the initial remote create', async () => {
    const harness = createHarness()
    const createGate = harness.holdNextTabCreate()
    harness.lifecycle.open()
    await settle()

    const navigationToken = harness.lifecycle.tokens.createOperationToken()
    expect(navigationToken).not.toBeNull()
    const navigationPage = harness.lifecycle.session.ensureRemotePage(navigationToken!)
    await settle()

    expect(harness.tabCreateAttempts).toBe(1)
    createGate.release()
    await expect(navigationPage).resolves.toBe('page-1')
    await settle()

    expect(harness.streams).toHaveLength(1)
    expect(harness.streams[0].pageId).toBe('page-1')
  })

  it('closes the created page when every overlapping waiter is superseded', async () => {
    const harness = createHarness()
    const createGate = harness.holdNextTabCreate()
    const close = harness.lifecycle.open()
    await settle()

    const overlapping = harness.lifecycle.session.ensureRemotePage(
      harness.lifecycle.tokens.createOperationToken()!
    )
    close()
    createGate.release()
    await expect(overlapping).resolves.toBeNull()
    await settle()

    expect(harness.tabCreateAttempts).toBe(1)
    expect(harness.closedCreatedPages).toEqual(['page-1'])
    expect(harness.streams).toHaveLength(0)
  })

  // Closing a tab while its stream is parked runs dispose() with no effect cleanup left to pair
  // with it, so unmount safety rests entirely on parking having already unsubscribed.
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

  // STA-3483: the shipped bug was a single 500ms retry that never rescheduled.
  it('keeps retrying a dropped stream with backoff instead of stopping after one attempt', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.queueSubscribeError(new Error('stream refused'))

    harness.streams[0].emitEnd()
    await settle()
    expect(harness.subscribeAttempts).toBe(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(harness.subscribeAttempts).toBe(2)
    expect(harness.streams).toHaveLength(1)

    // Why: the second attempt is the next backoff step (1000ms), not another 500ms tick.
    await vi.advanceTimersByTimeAsync(999)
    expect(harness.subscribeAttempts).toBe(2)

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.subscribeAttempts).toBe(3)
    expect(harness.streams).toHaveLength(2)
  })

  it('does not retry a runtime that cannot stream at all', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.setCapabilities([])

    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    const attemptsAfterFirstRetry = harness.subscribeAttempts

    await vi.advanceTimersByTimeAsync(120_000)

    expect(harness.subscribeAttempts).toBe(attemptsAfterFirstRetry)
    expect(harness.currentError).toBe(
      'The selected runtime does not support remote browser streaming.'
    )
  })

  // Fix 2: a worktree the host reports as genuinely gone cannot come back on this connection, so
  // retrying it is unbounded work with a permanent error toast. Note the code used here is one the
  // host only sends about the thing itself — `selector_not_found` is deliberately excluded, because
  // it also covers a resolution that merely failed right now.
  it('stops retrying when the runtime reports the stream target is gone', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('worktree_not_found_on_server', 'worktree is gone'))

    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.subscribeAttempts).toBe(2)
    expect(harness.currentError).toBe('worktree is gone')

    await vi.advanceTimersByTimeAsync(120_000)

    expect(harness.subscribeAttempts).toBe(2)
  })

  it('keeps retrying a failure the host could still recover from', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('runtime_timeout', 'runtime timed out'))

    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.subscribeAttempts).toBe(2)

    await vi.advanceTimersByTimeAsync(1000)

    expect(harness.subscribeAttempts).toBe(3)
  })

  // Fix 3: a pane that healed itself must not keep showing the failure toast it recovered from.
  it('clears the failure a restart reported once the new stream goes live', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.queueSubscribeError(new Error('stream refused'))

    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.currentError).toBe('Lost connection to the remote server.')

    await vi.advanceTimersByTimeAsync(1000)
    harness.streams[1].emitReady()
    harness.streams[1].emitFrame()
    await settle()

    expect(harness.currentError).toBeNull()
  })

  // A stream that lasted must forget prior failures, or the next drop inherits their backoff.
  it('backs off from scratch after a stream is confirmed live again', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.queueSubscribeError(new Error('stream refused'))

    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(1000)
    harness.streams[1].emitReady()
    harness.streams[1].emitFrame()
    // Why the wait: a first frame alone does not refill the budget — only a sustained stream does.
    await vi.advanceTimersByTimeAsync(15_000)

    harness.streams[1].emitEnd()
    await settle()
    const attemptsBeforeSecondDrop = harness.subscribeAttempts

    await vi.advanceTimersByTimeAsync(500)

    expect(harness.subscribeAttempts).toBe(attemptsBeforeSecondDrop + 1)
  })

  it('restarts the stream for a viewport change and adopts the new subscription', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.setViewportSize({ width: 1200, height: 900 })
    harness.lifecycle.restartForViewport('page-1')
    await settle()

    expect(harness.streams).toHaveLength(2)
    expect(harness.streams[0].unsubscribeCount).toBe(1)
    expect(harness.streams[1].viewportWidth).toBe(1200)
  })

  it('renegotiates one legacy host-sized frame to a complete native-width viewport', async () => {
    const harness = createHarness()
    harness.setViewportSize({ width: 1097, height: 917 })
    await openStreamAndConfirmReady(harness)
    const recovered = harness.lifecycle.recoverLegacyFrame({
      imageWidth: 533,
      imageHeight: 917,
      deviceWidth: 1097,
      deviceHeight: 917
    })
    await settle()

    expect(recovered).toBe(true)
    expect(harness.streams).toHaveLength(2)
    expect(harness.streams[0].unsubscribeCount).toBe(1)
    expect(harness.streams[1]).toMatchObject({ viewportWidth: 533, viewportHeight: 917 })
    harness.streams[0].emitClose()
    await settle()
    expect(harness.streams).toHaveLength(2)
    harness.streams[1].emitReady()
    await settle()
    expect(harness.syncedViewportSizes.at(-1)).toEqual({ width: 533, height: 917 })

    const secondRecovery = harness.lifecycle.recoverLegacyFrame({
      imageWidth: 320,
      imageHeight: 446,
      deviceWidth: 533,
      deviceHeight: 446
    })
    await settle()

    expect(secondRecovery).toBe(false)
    expect(harness.streams).toHaveLength(2)
  })

  it('leaves a corrected host frame on its existing stream', async () => {
    const harness = createHarness()
    harness.setViewportSize({ width: 1097, height: 917 })
    await openStreamAndConfirmReady(harness)

    expect(
      harness.lifecycle.recoverLegacyFrame({
        imageWidth: 2194,
        imageHeight: 1834,
        deviceWidth: 1097,
        deviceHeight: 917
      })
    ).toBe(false)
    expect(harness.streams).toHaveLength(1)
    expect(harness.streams[0].unsubscribeCount).toBe(0)
  })

  it('keeps the compatibility viewport when a live stream reconnects', async () => {
    const harness = createHarness()
    harness.setViewportSize({ width: 1097, height: 917 })
    await openStreamAndConfirmReady(harness)
    expect(
      harness.lifecycle.recoverLegacyFrame({
        imageWidth: 533,
        imageHeight: 917,
        deviceWidth: 1097,
        deviceHeight: 917
      })
    ).toBe(true)
    await settle()
    harness.streams[1].emitReady()
    await settle()

    harness.streams[1].emitEnd()
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.streams[2]).toMatchObject({ viewportWidth: 533, viewportHeight: 917 })
    harness.streams[2].emitReady()
    await settle()
    expect(harness.syncedViewportSizes.at(-1)).toEqual({ width: 533, height: 917 })
  })

  it('keeps observer viewport syncs on the active compatibility viewport', async () => {
    const harness = createHarness()
    harness.setViewportSize({ width: 1097, height: 917 })
    await openStreamAndConfirmReady(harness)
    expect(
      harness.lifecycle.recoverLegacyFrame({
        imageWidth: 533,
        imageHeight: 917,
        deviceWidth: 1097,
        deviceHeight: 917
      })
    ).toBe(true)
    await settle()
    harness.streams[1].emitReady()
    await settle()

    expect(harness.lifecycle.viewportForSync()).toEqual({ width: 533, height: 917 })
  })

  it('releases the compatibility viewport before syncing a real pane resize', async () => {
    const harness = createHarness()
    harness.setViewportSize({ width: 1097, height: 917 })
    await openStreamAndConfirmReady(harness)
    expect(
      harness.lifecycle.recoverLegacyFrame({
        imageWidth: 533,
        imageHeight: 917,
        deviceWidth: 1097,
        deviceHeight: 917
      })
    ).toBe(true)
    await settle()
    harness.streams[1].emitReady()
    await settle()

    harness.setViewportSize({ width: 1200, height: 900 })

    expect(harness.lifecycle.viewportForSync()).toEqual({ width: 1200, height: 900 })
  })

  it('allows one fresh compatibility negotiation after a real pane resize', async () => {
    const harness = createHarness()
    harness.setViewportSize({ width: 1097, height: 917 })
    await openStreamAndConfirmReady(harness)
    expect(
      harness.lifecycle.recoverLegacyFrame({
        imageWidth: 533,
        imageHeight: 917,
        deviceWidth: 1097,
        deviceHeight: 917
      })
    ).toBe(true)
    await settle()
    harness.streams[1].emitReady()
    await settle()

    harness.setViewportSize({ width: 1200, height: 900 })
    harness.lifecycle.restartForViewport('page-1')
    await settle()
    harness.streams[2].emitReady()
    await settle()

    expect(
      harness.lifecycle.recoverLegacyFrame({
        imageWidth: 533,
        imageHeight: 900,
        deviceWidth: 1200,
        deviceHeight: 900
      })
    ).toBe(true)
    await settle()
    expect(harness.streams[3]).toMatchObject({ viewportWidth: 533, viewportHeight: 900 })
  })

  // waitForViewportSize can block for a few frames while the element is unmeasurable. An attempt
  // superseded during that window used to resume and claim the stream token anyway, stranding the
  // live stream: its 'ready' was then dropped as stale, and because one ready-deadline is kept per
  // pane, the resuming attempt cancelled the safety net too. The pane sat in 'opening' with nothing
  // pending — no retry, no reconnect, forever.
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
    supersedingStream.emitFrame()
    await settle()
    expect(harness.currentStatusKind).toBe('live')
  })

  it('ignores a viewport change that is within measurement jitter', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.setViewportSize({ width: 802, height: 601 })
    harness.lifecycle.restartForViewport('page-1')
    await settle()

    expect(harness.streams).toHaveLength(1)
  })

  // Fix 1a: a superseded viewport restart must not clear busy for the operation that replaced it.
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

  // Fix 1b: nor may it raise the error of a restart that is no longer the current operation.
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

  // The generation bump in restartForViewport is what retires other in-flight operation work.
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

  it('bounds legacy navigation refresh retries and cancels them on supersession', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    const refreshToken = harness.lifecycle.tokens.createOperationToken('page-1')!
    const initialTabShows = harness.rpcLog.filter((method) => method === 'browser.tabShow').length

    harness.lifecycle.session.scheduleTabInfoRefresh(refreshToken, 250, 4)
    await vi.advanceTimersByTimeAsync(3_750)

    expect(harness.rpcLog.filter((method) => method === 'browser.tabShow')).toHaveLength(
      initialTabShows + 4
    )

    harness.lifecycle.session.scheduleTabInfoRefresh(refreshToken, 250, 4)
    harness.lifecycle.open()
    await settle()
    const tabShowsAfterOpen = harness.rpcLog.filter((method) => method === 'browser.tabShow').length
    await vi.advanceTimersByTimeAsync(4_000)

    expect(harness.rpcLog.filter((method) => method === 'browser.tabShow')).toHaveLength(
      tabShowsAfterOpen
    )
  })

  it('closes a page the runtime reports as missing instead of retrying it', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.streams[0].emitResponseFailure('browser_tab_not_found', 'page is gone')
    await settle()

    expect(harness.closedPages).toEqual(['page-1'])
    expect(harness.subscribeAttempts).toBe(1)
  })

  it('ignores a malformed success payload without poisoning the live subscription', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()

    expect(() => harness.streams[0].emitMalformedSuccess()).not.toThrow()
    harness.streams[0].emitReady()
    harness.streams[0].emitFrame()
    await settle()

    expect(harness.currentStatusKind).toBe('live')
  })

  // A transport error is NOT guaranteed to be followed by a close: the web client's
  // notifySubscriptionsError clears its subscription map and then delivers onError only. So this
  // must land somewhere the user can act from, or the pane is stranded busy with no way back.
  it('leaves a transport error actionable when no close follows it', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.streams[0].emitTransportError('runtime_timeout', 'socket hiccup')
    await vi.advanceTimersByTimeAsync(120_000)

    // Pane-authored, not the transport's own string: 'socket hiccup' names our plumbing and tells
    // the user nothing they can act on.
    expect(harness.currentError).toBe('Lost connection to the remote server.')
    expect(harness.subscribeAttempts).toBe(1)
    expect(harness.reconnectOffered).toBe(true)
    // Critically: not busy. A spinner here would also disable the pane's own input handlers.
    expect(harness.busyLog.at(-1)).toBe(false)
  })

  // The same path, but before the host confirmed anything. This is the one stream-ending path that
  // deliberately keeps its stream token, so the 'never said ready' deadline stayed armed and its
  // guard still passed — firing 30s later against a stream already declared stopped and withdrawing
  // the reconnect control with no user action at all.
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

  it('ignores stream events once the pane is unmounted', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    const errorsBeforeUnmount = harness.errorLog.length

    harness.identity.mounted = false
    harness.lifecycle.dispose()
    harness.streams[0].emitStreamError('too late')
    await vi.advanceTimersByTimeAsync(120_000)

    expect(harness.errorLog).toHaveLength(errorsBeforeUnmount)
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
    harness.streams[1].emitFrame()
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

  it('unsubscribes while a stream is still opening', async () => {
    const harness = createHarness()
    const pendingSubscribe = harness.holdNextSubscribe()
    const close = harness.lifecycle.open()
    await settle()

    close()
    pendingSubscribe.release()
    await settle()

    expect(harness.streams).toHaveLength(1)
    expect(harness.streams[0].unsubscribeCount).toBe(1)
  })
})

// Why these exist: deleting every setReconnectAvailable call site left the whole suite green, so the
// affordance had no unit coverage at all — only two E2E paths. Each test below fails if its own call
// site is removed.
describe('RemoteBrowserStreamLifecycle reconnect affordance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('withholds reconnect while retries remain, then offers it once the budget is spent', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('runtime_unavailable', 'socket died'))

    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    // One attempt spent, four remain: offering a control here invites fighting the retry loop.
    expect(harness.reconnectOffered).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.reconnectOffered).toBe(true)
    expect(harness.currentError).toBe('Lost connection to the remote server.')
  })

  // The regression the review caught: stopping automatic retries is not the same as removing the
  // user's last resort. selector_not_found already had to leave the permanent set once, so a
  // misclassification here must stay recoverable by hand.
  it('offers reconnect even when it stops retrying a permanent failure', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('worktree_not_found_on_server', 'worktree is gone'))

    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(harness.reconnectOffered).toBe(true)
    // The specific message survives: it says something true that "Lost connection" would not.
    expect(harness.currentError).toBe('worktree is gone')
  })

  it('offers reconnect when the stream never opened at all', async () => {
    const harness = createHarness()
    harness.failEverySubscribe(rpcError('runtime_unavailable', 'host is down'))
    harness.lifecycle.open()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(harness.reconnectOffered).toBe(true)
    expect(harness.currentError).toBe('Cannot reach the remote server.')
  })

  it('clears the offer when the pane reopens and the stream comes back', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('runtime_unavailable', 'socket died'))
    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.reconnectOffered).toBe(true)

    // NOTE ON WHAT THIS PINS: the clear comes from open(), not from onReady. Once the budget is
    // spent the scheduler has stopped, so nothing reaches onReady except a fresh open() — which
    // clears first. onReady's own clear is therefore defence-in-depth against a future path that
    // sets the flag and then recovers in place; it is deliberately NOT claimed as covered.
    harness.failEverySubscribe(null)
    harness.lifecycle.open()
    await settle()
    harness.streams.at(-1)!.emitReady()
    await settle()

    expect(harness.reconnectOffered).toBe(false)
  })

  // A reopen starts a fresh budget, so a flag left over from a previous exhaustion would show the
  // control while attempts remain.
  it('does not carry a spent offer into the next open', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('runtime_unavailable', 'socket died'))
    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.reconnectOffered).toBe(true)

    // Failures cleared and no 'ready' emitted yet: the flag must already be down from open() alone,
    // not from the later confirmation.
    harness.failEverySubscribe(null)
    harness.lifecycle.open()
    await settle()
    expect(harness.reconnectOffered).toBe(false)
  })
})

// NEW-1 repro: a budget can drain without any attempt throwing. Each restart subscribes fine, then
// the stream ends before 'ready'. The catch never runs, so setError is never called — and the
// Reconnect control renders only inside the error toast, so exhaustion produces an invisible
// affordance, busy stuck true, and no further retries. On main this cycle retried forever and
// self-healed, so it is a regression in the exact class this work exists to remove.
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

// A transport error is NOT a stop. On a real socket failure the client calls onError and then
// onClose (src/shared/remote-runtime-client.ts fail()), and it is onClose that starts the retry
// budget. Announcing a stop on the error therefore raises the reconnect control ~500ms before the
// first automatic attempt — the one state this pane must never present, and with raw transport copy
// the pane exists to keep out of the UI. The E2E cannot see this: manual disconnect delivers close
// without error, which is the single drop shape where the bug is absent.
describe('RemoteBrowserStreamLifecycle transport error', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Why this pins the METHOD and not just the call site: cancelling the deadline on a transport
  // error must not also forget how long the stream had been alive, because a close that follows has
  // to refill the budget for a stream that had proved healthy. Swapping stopWaitingForReady's
  // clearDeadline() for clear() — deleting exactly what its comment argues for — left all 322 tests
  // green while silently costing the user one automatic retry.
  it('still refills the budget when a close follows a transport error on a healthy stream', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    // Spend one budget step: a drop whose retry succeeds.
    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    harness.streams[1].emitReady()
    harness.streams[1].emitFrame()
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

  // The usual case: a close does follow. It must take the control back down for the whole ladder,
  // so the user is not offered a manual retry that competes with the automatic one about to run.
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

  // The budget absorbs a blip invisibly: a drop whose first retry succeeds must say nothing at all.
  it('says nothing when the first retry succeeds', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.streams[0].emitClose()
    await vi.advanceTimersByTimeAsync(600)
    harness.streams.at(-1)!.emitReady()
    await settle()

    expect(harness.errorLog.filter((entry) => entry !== null)).toEqual([])
  })
})

// These pin the remaining announce sites. Each was verified to leave the suite green when its
// announce was downgraded to a bare setError — the gap that let a wrong one ship.
describe('RemoteBrowserStreamLifecycle stop announcements', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers reconnect when the runtime reports the stream itself failed', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.streams[0].emitStreamError('screencast pipeline exploded')
    await vi.advanceTimersByTimeAsync(60_000)

    // Non-restarting by design, so nothing else would ever hand the user a way back.
    expect(harness.reconnectOffered).toBe(true)
    expect(harness.currentError).toBe('screencast pipeline exploded')
    expect(harness.busyLog.at(-1)).toBe(false)
  })

  it('offers reconnect when a viewport restart cannot re-subscribe', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.failEverySubscribe(rpcError('runtime_unavailable', 'resize refused'))
    harness.setViewportSize({ width: 1400, height: 900 })
    harness.lifecycle.restartForViewport(harness.streams[0].pageId)
    await vi.advanceTimersByTimeAsync(60_000)

    // A resize during a blip tears down a live subscription and never reaches the retry budget.
    expect(harness.reconnectOffered).toBe(true)
    expect(harness.busyLog.at(-1)).toBe(false)
  })

  // This was the one failure path still forwarding raw transport text, which is written for logs and
  // names our internals. The pane speaks for itself everywhere else.
  it('speaks for itself when a viewport restart fails transiently', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.failEverySubscribe(
      rpcError('runtime_unavailable', 'Runtime environment pairing changed; refresh and try again')
    )
    harness.setViewportSize({ width: 1400, height: 900 })
    harness.lifecycle.restartForViewport(harness.streams[0].pageId)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(harness.currentError).toBe('Lost connection to the remote server.')
  })

  // ...but a failure we classified ourselves keeps its own message, which says something true.
  it('keeps a permanent viewport-restart failure specific', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.failEverySubscribe(rpcError('worktree_not_found_on_server', 'worktree is gone'))
    harness.setViewportSize({ width: 1400, height: 900 })
    harness.lifecycle.restartForViewport(harness.streams[0].pageId)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(harness.currentError).toBe('worktree is gone')
  })
})

// Two writers, one value — the shape every round of this review has found. The stream token is
// claimed before subscribe is awaited, so a close can arrive and arm a restart while the subscribe
// promise is still rejecting. The host does exactly this: it closes the subscription and only then
// throws (src/main/ipc/runtime-environments.ts, stale pairing).
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

    // The armed restart owns the status: offering a manual control here shows it for one backoff
    // step and then swaps it for a spinner, which is the state this pane must never present.
    expect(harness.reconnectOffered).toBe(false)
    expect(harness.busyLog.at(-1)).toBe(true)
    expect(harness.currentError).toBeNull()
  })

  it('still reaches a reconnect once that restart budget is spent', async () => {
    const harness = createHarness()
    harness.closeThenRejectNextSubscribe()
    harness.lifecycle.open()
    await settle()
    harness.failEverySubscribe(rpcError('runtime_unavailable', 'still down'))

    await vi.advanceTimersByTimeAsync(60_000)

    expect(harness.reconnectOffered).toBe(true)
    expect(harness.currentError).toBe('Lost connection to the remote server.')
  })
})

// A subscribe resolves as soon as the request is sent, so a host that accepts and then goes silent
// is bounded by nothing on the client. Both busy states hide the reconnect, so this stranded the
// pane behind a permanent spinner with dead input handlers — the exact failure this work removes.
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

// 'ready' proves the host accepted the subscribe, not that the stream is sustained. CDP allows one
// screencast per page, so a second subscriber on the same remote page evicts the first on every
// attempt. Refilling the budget on 'ready' turned that into the unbounded retry loop the budget
// exists to prevent.
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
      // Long enough for the next backoff step to fire, short enough that the stream never proves
      // itself healthy.
      await vi.advanceTimersByTimeAsync(9_000)
      harness.streams.at(-1)!.emitReady()
      await settle()
    }

    expect(harness.reconnectOffered).toBe(true)
    expect(harness.busyLog.at(-1)).toBe(false)
  })
})
