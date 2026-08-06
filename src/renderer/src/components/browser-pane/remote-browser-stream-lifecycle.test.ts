import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserPageHandle, RemoteBrowserRpcCall } from './remote-browser-page-session'
import type { RemoteBrowserScreencastSubscribe } from './remote-browser-screencast-subscription'
import type { RemoteBrowserViewportSize } from './remote-browser-stream-tokens'
import { isBrowserPaneUiRuntimeRpcParams } from '../../../../shared/runtime-rpc-feature-interaction-source'

type Gate = {
  wait: Promise<void>
  release: () => void
  fail: (error: unknown) => void
}

function createGate(): Gate {
  let release!: () => void
  let fail!: (error: unknown) => void
  const wait = new Promise<void>((resolve, reject) => {
    release = () => resolve()
    fail = (error: unknown) => reject(error)
  })
  // Why: the gate is released by the test, not by this tick; an unhandled rejection would fail the run.
  wait.catch(() => {})
  return { wait, release, fail }
}

type FakeScreencastStream = {
  pageId: string
  params: unknown
  viewportWidth: number | undefined
  unsubscribeCount: number
  emitReady: () => void
  emitEnd: () => void
  emitStreamError: (message: string) => void
  emitResponseFailure: (code: string, message: string) => void
  emitTransportError: (code: string, message: string) => void
  emitClose: () => void
}

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function createHarness() {
  const identity = {
    mounted: true,
    active: true,
    tabId: 'tab-1',
    environmentId: 'env-1' as string | null,
    pageExists: true
  }
  const busyLog: boolean[] = []
  const errorLog: (string | null)[] = []
  const appliedTitles: string[] = []
  const closedPages: (string | null)[] = []
  const streams: FakeScreencastStream[] = []
  const rpcLog: string[] = []

  let capabilities: string[] = ['browser.screencast.v1']
  let storedHandle: RemoteBrowserPageHandle | null = null
  let viewportSize: RemoteBrowserViewportSize | null = { width: 800, height: 600 }
  let statusGate: Gate | null = null
  let tabShowGate: Gate | null = null
  let persistentSubscribeError: unknown = null
  const subscribeErrorQueue: unknown[] = []
  let subscribeAttempts = 0

  const callRpc = (async (_target: unknown, method: string) => {
    rpcLog.push(method)
    if (method === 'status.get') {
      if (statusGate) {
        const gate = statusGate
        statusGate = null
        await gate.wait
      }
      return { capabilities }
    }
    if (method === 'browser.tabShow') {
      if (tabShowGate) {
        const gate = tabShowGate
        tabShowGate = null
        await gate.wait
      }
      return { tab: { url: 'https://example.test/', title: 'Example' } }
    }
    if (method === 'browser.tabCreate') {
      return { browserPageId: 'page-1' }
    }
    return {}
  }) as unknown as RemoteBrowserRpcCall

  const subscribeScreencast: RemoteBrowserScreencastSubscribe = async (args, callbacks) => {
    subscribeAttempts += 1
    const error = subscribeErrorQueue.shift() ?? persistentSubscribeError
    if (error) {
      throw error
    }
    const params = args.params as {
      page: string
      viewportWidth?: number
    }
    const respond = (result: unknown): void => {
      callbacks.onResponse({ id: 'sub-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } })
    }
    const stream: FakeScreencastStream = {
      pageId: params.page,
      params: args.params,
      viewportWidth: params.viewportWidth,
      unsubscribeCount: 0,
      emitReady: () =>
        respond({
          type: 'ready',
          subscriptionId: 'sub-1',
          browserPageId: params.page,
          format: 'jpeg',
          tab: { url: 'https://example.test/', title: 'Example' }
        }),
      emitEnd: () => respond({ type: 'end', subscriptionId: 'sub-1' }),
      emitStreamError: (message) => respond({ type: 'error', message }),
      emitResponseFailure: (code, message) =>
        callbacks.onResponse({
          id: 'sub-1',
          ok: false,
          error: { code, message },
          _meta: { runtimeId: 'runtime-1' }
        }),
      emitTransportError: (code, message) => callbacks.onError?.({ code, message }),
      emitClose: () => callbacks.onClose?.()
    }
    streams.push(stream)
    return {
      unsubscribe: () => {
        stream.unsubscribeCount += 1
      }
    }
  }

  const lifecycle = new RemoteBrowserStreamLifecycle({
    identity: {
      isMounted: () => identity.mounted,
      isActive: () => identity.active,
      getTabId: () => identity.tabId,
      getEnvironmentId: () => identity.environmentId,
      browserPageExists: () => identity.pageExists
    },
    callRpc,
    subscribeScreencast,
    getWorktreeSelector: () => 'worktree:wt-1',
    getCurrentUrl: () => 'https://example.test/',
    readStoredHandle: () => storedHandle,
    writeStoredHandle: (handle) => {
      storedHandle = handle
    },
    removeStoredHandle: () => {
      storedHandle = null
    },
    applyTabInfo: (tab) => appliedTitles.push(tab.title ?? ''),
    closeMissingRemotePage: (remotePageId) => closedPages.push(remotePageId),
    waitForViewportSize: async () => viewportSize,
    readViewportSize: () => viewportSize,
    syncViewport: async () => {},
    getDeviceScaleFactor: () => 1,
    setBusy: (value) => busyLog.push(value),
    setError: (message) => errorLog.push(message),
    clearFrame: () => {},
    handleFrameBytes: () => {}
  })

  return {
    lifecycle,
    identity,
    busyLog,
    errorLog,
    appliedTitles,
    closedPages,
    streams,
    rpcLog,
    get subscribeAttempts(): number {
      return subscribeAttempts
    },
    get currentError(): string | null {
      return errorLog.length > 0 ? (errorLog.at(-1) ?? null) : null
    },
    setCapabilities: (next: string[]) => {
      capabilities = next
    },
    setViewportSize: (next: RemoteBrowserViewportSize | null) => {
      viewportSize = next
    },
    queueSubscribeError: (error: unknown) => {
      subscribeErrorQueue.push(error)
    },
    failEverySubscribe: (error: unknown) => {
      persistentSubscribeError = error
    },
    holdNextStatusGet: (): Gate => {
      const gate = createGate()
      statusGate = gate
      return gate
    },
    holdNextTabShow: (): Gate => {
      const gate = createGate()
      tabShowGate = gate
      return gate
    }
  }
}

type Harness = ReturnType<typeof createHarness>

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function openStreamAndConfirmReady(harness: Harness): Promise<() => void> {
  const close = harness.lifecycle.open()
  await settle()
  harness.streams[0].emitReady()
  await settle()
  return close
}

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
    expect(harness.currentError).toBe('stream refused')

    await vi.advanceTimersByTimeAsync(1000)
    harness.streams[1].emitReady()
    await settle()

    expect(harness.currentError).toBeNull()
  })

  // A confirmed-live stream must forget prior failures, or the next drop inherits their backoff.
  it('backs off from scratch after a stream is confirmed live again', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.queueSubscribeError(new Error('stream refused'))

    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(1000)
    harness.streams[1].emitReady()
    await settle()

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

  it('closes a page the runtime reports as missing instead of retrying it', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.streams[0].emitResponseFailure('browser_tab_not_found', 'page is gone')
    await settle()

    expect(harness.closedPages).toEqual(['page-1'])
    expect(harness.subscribeAttempts).toBe(1)
  })

  it('reports a transport error without tearing the stream down', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)

    harness.streams[0].emitTransportError('runtime_timeout', 'socket hiccup')
    await vi.advanceTimersByTimeAsync(120_000)

    expect(harness.currentError).toBe('socket hiccup')
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
})
