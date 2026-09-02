import { vi } from 'vitest'
import { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserPageHandle, RemoteBrowserRpcCall } from './remote-browser-page-session'
import type { RemoteBrowserScreencastSubscribe } from './remote-browser-screencast-subscription'
import type { RemoteBrowserViewportSize } from './remote-browser-stream-tokens'
import {
  canReconnectRemoteBrowserStream,
  isRemoteBrowserStreamBusy,
  remoteBrowserStreamNotice,
  type RemoteBrowserStreamStatus
} from './remote-browser-stream-status'

export type Gate = {
  wait: Promise<void>
  release: () => void
  fail: (error: unknown) => void
}

export function createGate(): Gate {
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

export type FakeScreencastStream = {
  pageId: string
  params: unknown
  viewportWidth: number | undefined
  unsubscribeCount: number
  emitReady: () => void
  emitEnd: () => void
  emitStreamError: (message: string) => void
  emitMalformedSuccess: () => void
  emitResponseFailure: (code: string, message: string) => void
  emitTransportError: (code: string, message: string) => void
  emitClose: () => void
}

export function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function createHarness() {
  const identity = {
    mounted: true,
    active: true,
    tabId: 'tab-1',
    environmentId: 'env-1' as string | null,
    pageExists: true
  }
  const statusLog: RemoteBrowserStreamStatus[] = []
  const appliedTitles: string[] = []
  const closedPages: (string | null)[] = []
  const streams: FakeScreencastStream[] = []
  const rpcLog: string[] = []

  let capabilities: string[] = ['browser.screencast.v1']
  let storedHandle: RemoteBrowserPageHandle | null = null
  let viewportSize: RemoteBrowserViewportSize | null = { width: 800, height: 600 }
  let statusGate: Gate | null = null
  let viewportGate: Gate | null = null
  let tabShowGate: Gate | null = null
  let subscribeGate: Gate | null = null
  let persistentSubscribeError: unknown = null
  const subscribeErrorQueue: unknown[] = []
  let subscribeAttempts = 0
  let closeBeforeNextSubscribeRejects = false

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
    if (subscribeGate) {
      const gate = subscribeGate
      subscribeGate = null
      await gate.wait
    }
    // Models the host closing the subscription and only then rejecting the request, which is what
    // src/main/ipc/runtime-environments.ts does on a stale pairing.
    if (closeBeforeNextSubscribeRejects) {
      closeBeforeNextSubscribeRejects = false
      callbacks.onClose?.()
      throw rpcError(
        'runtime_unavailable',
        'Runtime environment pairing changed; refresh and try again'
      )
    }
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
      emitMalformedSuccess: () => respond(null),
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
    waitForViewportSize: async () => {
      if (viewportGate) {
        const gate = viewportGate
        viewportGate = null
        await gate.wait
      }
      return viewportSize
    },
    readViewportSize: () => viewportSize,
    syncViewport: async () => {},
    getDeviceScaleFactor: () => 1,
    setStatus: (status) => statusLog.push(status),
    clearFrame: () => {},
    handleFrameBytes: () => {}
  })

  return {
    lifecycle,
    identity,
    statusLog,
    appliedTitles,
    closedPages,
    streams,
    rpcLog,
    get subscribeAttempts(): number {
      return subscribeAttempts
    },
    // Kept as accessors so the assertions written against the old three-variable shape still read
    // naturally — they now derive from the one status, which is the point of the change.
    get errorLog(): (string | null)[] {
      return statusLog.map(remoteBrowserStreamNotice)
    },
    get busyLog(): boolean[] {
      return statusLog.map(isRemoteBrowserStreamBusy)
    },
    get reconnectOffered(): boolean {
      const status = statusLog.at(-1)
      return status ? canReconnectRemoteBrowserStream(status) : false
    },
    get currentStatusKind(): string | null {
      return statusLog.at(-1)?.kind ?? null
    },
    get currentError(): string | null {
      const status = statusLog.at(-1)
      return status ? remoteBrowserStreamNotice(status) : null
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
    closeThenRejectNextSubscribe: () => {
      closeBeforeNextSubscribeRejects = true
    },
    holdNextViewportSize: (): Gate => {
      const gate = createGate()
      viewportGate = gate
      return gate
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
    },
    holdNextSubscribe: (): Gate => {
      const gate = createGate()
      subscribeGate = gate
      return gate
    }
  }
}

export type Harness = ReturnType<typeof createHarness>

export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

export async function openStreamAndConfirmReady(harness: Harness): Promise<() => void> {
  const close = harness.lifecycle.open()
  await settle()
  harness.streams[0].emitReady()
  await settle()
  return close
}
