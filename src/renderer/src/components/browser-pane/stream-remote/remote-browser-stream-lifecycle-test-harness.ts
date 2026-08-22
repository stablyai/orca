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
import {
  createGate,
  RemoteBrowserRecoveryEvalGate,
  type Gate
} from './remote-browser-stream-test-gate'
import type { FakeScreencastStream } from './remote-browser-fake-screencast-stream'

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
  const closedCreatedPages: string[] = []
  const syncedViewportSizes: (RemoteBrowserViewportSize | null)[] = []

  let capabilities: string[] = ['browser.screencast.v1']
  let storedHandle: RemoteBrowserPageHandle | null = null
  let viewportSize: RemoteBrowserViewportSize | null = { width: 800, height: 600 }
  let statusGate: Gate | null = null
  let viewportGate: Gate | null = null
  let tabShowGate: Gate | null = null
  let tabCreateGate: Gate | null = null
  let subscribeGate: Gate | null = null
  const recoveryEval = new RemoteBrowserRecoveryEvalGate()
  let persistentSubscribeError: unknown = null
  const subscribeErrorQueue: unknown[] = []
  let subscribeAttempts = 0
  let tabCreateAttempts = 0
  let handledFrames = 0
  let closeBeforeNextSubscribeRejects = false

  const callRpc = (async (
    _target: unknown,
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal }
  ) => {
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
      tabCreateAttempts += 1
      if (tabCreateGate) {
        const gate = tabCreateGate
        tabCreateGate = null
        await gate.wait
      }
      return { browserPageId: `page-${tabCreateAttempts}` }
    }
    if (method === 'browser.tabClose') {
      closedCreatedPages.push((params as { page: string }).page)
    }
    if (method === 'browser.eval') {
      await recoveryEval.wait(options?.signal)
    }
    return {}
  }) as unknown as RemoteBrowserRpcCall

  const subscribeScreencast: RemoteBrowserScreencastSubscribe = async (args, callbacks) => {
    subscribeAttempts += 1
    const params = args.params as {
      page: string
      viewportWidth?: number
      viewportHeight?: number
    }
    const respond = (result: unknown): void => {
      callbacks.onResponse({ id: 'sub-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } })
    }
    const stream: FakeScreencastStream = {
      pageId: params.page,
      params: args.params,
      viewportWidth: params.viewportWidth,
      viewportHeight: params.viewportHeight,
      unsubscribeCount: 0,
      emitReady: () =>
        respond({
          type: 'ready',
          subscriptionId: 'sub-1',
          browserPageId: params.page,
          format: 'jpeg',
          tab: { url: 'https://example.test/', title: 'Example' }
        }),
      emitFrame: () => callbacks.onBinary?.(new Uint8Array([1, 2, 3])),
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
    let unsubscribed = false
    const handle = {
      unsubscribe: () => {
        if (!unsubscribed) {
          unsubscribed = true
          stream.unsubscribeCount += 1
        }
      }
    }
    callbacks.onSubscriptionStart?.(handle)
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
    streams.push(stream)
    return handle
  }

  let lifecycle!: RemoteBrowserStreamLifecycle
  lifecycle = new RemoteBrowserStreamLifecycle({
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
    syncViewport: async (_pageId, size) => {
      syncedViewportSizes.push(size)
    },
    getDeviceScaleFactor: () => 1,
    setStatus: (status) => statusLog.push(status),
    clearFrame: () => {},
    handleFrameBytes: () => {
      handledFrames += 1
    }
  })

  return {
    lifecycle,
    identity,
    statusLog,
    appliedTitles,
    closedPages,
    streams,
    rpcLog,
    closedCreatedPages,
    syncedViewportSizes,
    get subscribeAttempts(): number {
      return subscribeAttempts
    },
    get tabCreateAttempts(): number {
      return tabCreateAttempts
    },
    get handledFrames(): number {
      return handledFrames
    },
    get recoveryEvalAbortCount(): number {
      return recoveryEval.abortCount
    },
    get recoveryEvalSignal(): AbortSignal | null {
      return recoveryEval.signal
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
    holdNextTabCreate: (): Gate => {
      const gate = createGate()
      tabCreateGate = gate
      return gate
    },
    holdNextSubscribe: (): Gate => {
      const gate = createGate()
      subscribeGate = gate
      return gate
    },
    holdNextRecoveryEval: (): Gate => {
      return recoveryEval.hold()
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
  harness.streams[0].emitFrame()
  await settle()
  return close
}
