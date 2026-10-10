import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'
import type { PtyTransport } from './pty-transport-types'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
  latestSubscribePayload,
  inputFrameTexts,
  subscribeFrameCount,
  emitSnapshot,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const PAIRING_CHANGED = 'Runtime environment pairing changed; refresh and try again'

type RevisionedRequest = { method?: string; expectedEnvironmentPairingRevision?: number }

function requestRevision(request: unknown): number | undefined {
  return typeof request === 'object' &&
    request !== null &&
    'expectedEnvironmentPairingRevision' in request &&
    typeof request.expectedEnvironmentPairingRevision === 'number'
    ? request.expectedEnvironmentPairingRevision
    : undefined
}

function subscribeRevisions(): (number | undefined)[] {
  return runtimeSubscribe.mock.calls.map(([request]) => requestRevision(request))
}

/** A managed server's catalog row; its pairing handshake proves `hostKey`. */
function managedServer(pairingRevision: number, hostKey: string) {
  return {
    id: 'env-1',
    name: 'Box',
    createdAt: 1,
    updatedAt: pairingRevision,
    pairingRevision,
    hostKeyFingerprint: hostKey,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      { id: 'ws', kind: 'websocket' as const, label: 'Box', endpoint: 'ws://127.0.0.1:46768/' }
    ],
    preferredEndpointId: 'ws',
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46768,
      remotePort: 6768
    }
  }
}

/**
 * Main's environment record, mirrored into the real catalog store. A managed-server update
 * restarts the server and re-pairs it under the same environment id, so main refuses every request
 * that still carries the old revision — before it reaches the host, whose terminals are untouched.
 */
async function installRepairableMain(): Promise<{
  repair: (hostKey?: string) => void
  publishCatalog: () => void
  setReachable: (reachable: boolean) => void
  store: Awaited<ReturnType<typeof createCatalogStore>>
}> {
  let mainRevision = 1
  let mainHostKey = 'host-A'
  let reachable = true
  const unreachable = (): Error =>
    Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
      code: 'remote_runtime_unavailable'
    })
  const store = await createCatalogStore()
  const publishCatalog = (): void => {
    store.getState().setRuntimeEnvironments([managedServer(mainRevision, mainHostKey)])
  }
  publishCatalog()
  const { setRuntimeEnvironmentCatalogRefresher } =
    await import('@/runtime/runtime-environment-pairing-refresh')
  setRuntimeEnvironmentCatalogRefresher(async () => publishCatalog())
  const isStale = (request: RevisionedRequest): boolean =>
    request.expectedEnvironmentPairingRevision !== undefined &&
    request.expectedEnvironmentPairingRevision !== mainRevision
  const hostCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: RevisionedRequest) => {
    if (!reachable) {
      throw unreachable()
    }
    if (isStale(request)) {
      return {
        ok: false,
        error: { code: 'runtime_environment_changed', message: PAIRING_CHANGED }
      }
    }
    if (request.method === 'session.tabs.list') {
      return readyHostSessionInventoryResponse('terminal-1', 'host-tab-1')
    }
    return hostCall?.(request)
  })
  const hostSubscribe = runtimeSubscribe.getMockImplementation()
  runtimeSubscribe.mockImplementation(async (request: RevisionedRequest, callbacks: unknown) => {
    if (!reachable) {
      throw unreachable()
    }
    if (isStale(request)) {
      throw new Error(
        `Error invoking remote method 'runtimeEnvironments:subscribe': Error: ${PAIRING_CHANGED}`
      )
    }
    return hostSubscribe?.(request, callbacks)
  })
  return {
    repair: (hostKey = 'host-A') => {
      mainRevision = 2
      mainHostKey = hostKey
    },
    publishCatalog,
    setReachable: (next) => {
      reachable = next
    },
    store
  }
}

async function createCatalogStore() {
  vi.doMock('sonner', () => ({
    toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
  }))
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const { resetDeferredPeerChecksForTests } =
    await import('@/store/slices/runtime-environment-peer-replacement')
  resetDeferredPeerChecksForTests()
  return createTestStore()
}

async function restartServerUnderLivePane(tabId: string): Promise<{
  transport: PtyTransport
  onError: ReturnType<typeof vi.fn>
  repair: (hostKey?: string) => void
  publishCatalog: () => void
  setReachable: (reachable: boolean) => void
}> {
  const { repair, publishCatalog, setReachable } = await installRepairableMain()
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const onError = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId,
    leafId: 'pane:1'
  })
  transport.attach({
    existingPtyId: 'remote:env-1@@terminal-1',
    cols: 80,
    rows: 24,
    callbacks: { onError }
  })
  await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
  emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
  await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
  return { transport, onError, repair, publishCatalog, setReachable }
}

// A forced managed-server update re-pairs the environment while its terminals keep running.
describe('remote runtime pane across a pairing rotation', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  afterEach(async () => {
    const { setRuntimeEnvironmentCatalogRefresher } =
      await import('@/runtime/runtime-environment-pairing-refresh')
    setRuntimeEnvironmentCatalogRefresher(null)
  })

  it('rebinds a pane to its still-live terminal on the new pairing and delivers typed keys', async () => {
    const { transport, onError, repair } = await restartServerUnderLivePane('tab-1')
    const firstCallbacks = subscriptionCallbacks

    repair()
    firstCallbacks?.onClose?.()
    expect(transport.sendInput('echo typed-after-update\r', 'driving')).toBe(true)

    await vi.waitFor(() => expect(subscribeRevisions().at(-1)).toBe(2))
    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstCallbacks))
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')

    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(latestSubscribePayload().terminal).toBe('terminal-1')
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('echo typed-after-update\r'))
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('rebinds a pane whose stream reopened before main re-paired, instead of dropping its keys', async () => {
    const { transport, onError, repair, publishCatalog } = await restartServerUnderLivePane('tab-1')
    const firstCallbacks = subscriptionCallbacks

    // The server is back and the stream reopened on the old pairing; main re-pairs only afterwards.
    repair()
    publishCatalog()

    await vi.waitFor(() => expect(subscribeRevisions().at(-1)).toBe(2))
    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstCallbacks))
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
    expect(transport.sendInput('echo typed-after-repair\r', 'driving')).toBe(true)

    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('echo typed-after-repair\r'))
    expect(latestSubscribePayload().terminal).toBe('terminal-1')
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('rebinds a host session pane through its inventory on the new pairing', async () => {
    const { transport, onError, repair } =
      await restartServerUnderLivePane('web-terminal-host-tab-1')
    const firstCallbacks = subscriptionCallbacks

    repair()
    firstCallbacks?.onClose?.()

    await vi.waitFor(() => expect(subscribeRevisions().at(-1)).toBe(2), { timeout: 5_000 })
    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstCallbacks))
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')

    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(latestSubscribePayload().terminal).toBe('terminal-1')
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('Reconnect rebinds a pane whose retries stopped while the server restarted re-paired', async () => {
    vi.useFakeTimers()
    try {
      const { transport, onError, repair, publishCatalog, setReachable } =
        await restartServerUnderLivePane('web-terminal-host-tab-1')
      setReachable(false)
      subscriptionCallbacks?.onClose?.()
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      repair()
      setReachable(true)
      // Another subscriber's refusal already brought the renderer catalog to the new revision.
      publishCatalog()
      const subscribesBefore = runtimeSubscribe.mock.calls.length
      runtimeCall.mockClear()
      expect(transport.retryRecovery?.()).toBe(true)

      await vi.waitFor(() =>
        expect(runtimeSubscribe.mock.calls.length).toBeGreaterThan(subscribesBefore)
      )
      expect(subscribeRevisions().at(-1)).toBe(2)
      await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
      emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
      await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      for (const [request] of runtimeCall.mock.calls) {
        expect(requestRevision(request)).toBe(2)
      }
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['a host session pane', 'web-terminal-host-tab-1'],
    ['a client-placed pane', 'tab-1']
  ])(
    'sends nothing from %s to a different machine re-paired under the same id',
    async (_label, tabId) => {
      vi.useFakeTimers()
      try {
        const { transport, repair, publishCatalog } = await restartServerUnderLivePane(tabId)
        const callsBefore = runtimeCall.mock.calls.length
        const subscribesBefore = runtimeSubscribe.mock.calls.length

        // A reinstalled or replacement server: same registration, different host key.
        repair('host-B')
        publishCatalog()
        transport.sendInput('typed after the swap\r', 'driving')
        await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS * 2)

        const reachedNewMachine = [
          ...runtimeCall.mock.calls.slice(callsBefore),
          ...runtimeSubscribe.mock.calls.slice(subscribesBefore)
        ].filter(([request]) => requestRevision(request) === 2)
        expect(reachedNewMachine).toEqual([])
        expect(inputFrameTexts()).toEqual([])
        transport.destroy?.()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('holds a pane while the re-paired host identity is unresolved, then follows it once proven', async () => {
    vi.useFakeTimers()
    try {
      const { transport, repair, publishCatalog } = await restartServerUnderLivePane('tab-1')
      const firstCallbacks = subscriptionCallbacks
      repair('')
      publishCatalog()
      firstCallbacks?.onClose?.()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(subscribeRevisions().filter((revision) => revision === 2)).toEqual([])

      repair('host-A')
      publishCatalog()
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(subscribeRevisions().at(-1)).toBe(2))
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
      emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
      await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
