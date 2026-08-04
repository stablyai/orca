import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

// Why: the recovery cutoff no longer tears down the retry registry entry or the accepted-snapshot
// listener, so those two module-global collections are the only places a latched pane can accumulate.
describe('remote runtime pty latched-pane retention', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const refreshSessionTabsSnapshot = vi.fn(async () => {})
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null
  let hostListCalls = 0

  function emitMultiplexReady(): void {
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })
  }

  function latestSubscribePayload(): { streamId: number; terminal: string } {
    const frame = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((candidate) => candidate?.opcode === TerminalStreamOpcode.Subscribe)
    if (!frame) {
      throw new Error('missing terminal subscribe frame')
    }
    const payload = decodeTerminalStreamJson<{ streamId: number; terminal: string }>(frame.payload)
    if (!payload) {
      throw new Error('invalid terminal subscribe payload')
    }
    return payload
  }

  function subscribeFrameCount(): number {
    return subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe).length
  }

  // Why: every pane needs its own host surface, otherwise a later pane reuses the earlier pane's
  // multiplexed stream and never enters recovery at all.
  const paneIdentity = (pane: number) => ({
    hostTabId: `tab-${pane}`,
    tabId: `web-terminal-tab-${pane}`,
    leafId: `pane:${pane}`,
    handle: `terminal-stale-${pane}`
  })

  const PANE_COUNT = 24

  // Why: one payload carries every pane's surface, matching the real per-worktree session.tabs
  // response that any polling pane receives.
  function hostSnapshot(
    snapshotVersion: number,
    publicationEpoch: string
  ): RuntimeMobileSessionTabsResult {
    return {
      worktree: 'wt-1',
      publicationEpoch,
      snapshotVersion,
      activeGroupId: null,
      activeTabId: `${paneIdentity(0).hostTabId}::${paneIdentity(0).leafId}`,
      activeTabType: 'terminal' as const,
      tabs: Array.from({ length: PANE_COUNT }, (_unused, pane) => {
        const identity = paneIdentity(pane)
        return {
          type: 'terminal' as const,
          id: `${identity.hostTabId}::${identity.leafId}`,
          parentTabId: identity.hostTabId,
          leafId: identity.leafId,
          title: 'Claude Code',
          isActive: pane === 0,
          status: 'ready' as const,
          terminal: identity.handle
        }
      })
    }
  }

  async function attachStalePane(pane: number) {
    const identity = paneIdentity(pane)
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: identity.tabId,
      leafId: identity.leafId,
      onPtyExit: vi.fn(),
      onPtyRebind: vi.fn()
    })
    const subscribesBefore = subscribeFrameCount()
    transport.attach({
      existingPtyId: `remote:env-1@@${identity.handle}`,
      cols: 80,
      rows: 24,
      callbacks: { onError: vi.fn() }
    })
    await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(subscribesBefore))

    // The host keeps publishing the same live handle, so bounded replacement polling finds no
    // replacement and stops quietly: the exact shape that leaves the pane latched but revivable.
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'terminal_handle_stale'
      }
    })
    return transport
  }

  async function registries() {
    const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
    const recoveryState = await import('./remote-runtime-pty-recovery-state')
    return {
      subscribers: handleEvents.getWebSessionTerminalHandleSubscriberCountForTests(),
      scheduled: recoveryState.getScheduledRemoteRuntimePtyRecoveryCountForTests()
    }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: refreshSessionTabsSnapshot
    }))
    vi.clearAllMocks()
    subscriptionCallbacks = null
    hostListCalls = 0
    subscriptionSendBinary.mockReset()
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'session.tabs.list') {
        hostListCalls += 1
        return { ok: true, result: hostSnapshot(hostListCalls + 1, 'epoch-1') }
      }
      if (request.method === 'session.tabs.activate') {
        return { ok: true, result: hostSnapshot(1, 'epoch-1') }
      }
      if (request.method === 'terminal.resolvePane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        const separator = params.paneKey.indexOf(':')
        const paneTabId = params.paneKey.slice(0, separator)
        const pane = Number(paneTabId.slice(paneTabId.lastIndexOf('-') + 1))
        return {
          ok: true,
          result: {
            terminal: {
              handle: paneIdentity(pane).handle,
              tabId: paneTabId,
              leafId: params.paneKey.slice(separator + 1),
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: {} }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
  })

  it('returns listener and retry-registry counts to baseline across destroy cycles', async () => {
    vi.useFakeTimers()
    try {
      expect(await registries()).toEqual({ subscribers: 0, scheduled: 0 })
      const latched: { subscribers: number; scheduled: number }[] = []
      const settled: { subscribers: number; scheduled: number }[] = []

      for (let cycle = 0; cycle < 20; cycle += 1) {
        const transport = await attachStalePane(cycle)
        await vi.advanceTimersByTimeAsync(66_000)
        expect(transport.getRecoveryState?.().phase).toBe('disconnected')
        latched.push(await registries())
        transport.destroy?.()
        await vi.advanceTimersByTimeAsync(1_000)
        settled.push(await registries())
      }

      // A latched pane deliberately holds exactly one listener and one registry entry...
      expect(latched).toEqual(Array.from({ length: 20 }, () => ({ subscribers: 1, scheduled: 1 })))
      // ...and destroy releases both, so twenty cycles do not accumulate anything.
      expect(settled).toEqual(Array.from({ length: 20 }, () => ({ subscribers: 0, scheduled: 0 })))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns to baseline when a latched pane is detached rather than destroyed', async () => {
    vi.useFakeTimers()
    try {
      const settled: { subscribers: number; scheduled: number }[] = []
      for (let cycle = 0; cycle < 20; cycle += 1) {
        const transport = await attachStalePane(cycle)
        await vi.advanceTimersByTimeAsync(66_000)
        expect(transport.getRecoveryState?.().phase).toBe('disconnected')
        transport.detach?.()
        await vi.advanceTimersByTimeAsync(1_000)
        settled.push(await registries())
      }
      expect(settled).toEqual(Array.from({ length: 20 }, () => ({ subscribers: 0, scheduled: 0 })))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds one listener and one registry entry per concurrently latched pane', async () => {
    vi.useFakeTimers()
    try {
      const transports: Awaited<ReturnType<typeof attachStalePane>>[] = []
      for (let pane = 0; pane < 8; pane += 1) {
        transports.push(await attachStalePane(pane))
        await vi.advanceTimersByTimeAsync(66_000)
      }
      // Retention is per live pane, not per timeout: eight latched panes hold eight of each.
      expect(await registries()).toEqual({ subscribers: 8, scheduled: 8 })

      for (const transport of transports) {
        transport.destroy?.()
      }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await registries()).toEqual({ subscribers: 0, scheduled: 0 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a latched pane fully quiescent — no timers, no RPCs, no growth', async () => {
    vi.useFakeTimers()
    try {
      const transport = await attachStalePane(0)
      await vi.advanceTimersByTimeAsync(66_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      const baseline = await registries()
      const callsAtLatch = runtimeCall.mock.calls.length
      const timersAtLatch = vi.getTimerCount()
      // Nothing is armed once the window is spent: the pane costs one listener and one registry
      // entry, and nothing else, no matter how long it stays latched.
      expect(timersAtLatch).toBe(0)

      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(runtimeCall.mock.calls.length).toBe(callsAtLatch)
      expect(vi.getTimerCount()).toBe(0)
      expect(await registries()).toEqual(baseline)

      transport.destroy?.()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await registries()).toEqual({ subscribers: 0, scheduled: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not stack listeners, registry entries or timers across repeated revive cycles', async () => {
    vi.useFakeTimers()
    try {
      const { retryAllRemoteRuntimePtyRecoveriesNow } = await import(
        './remote-runtime-pty-recovery-state'
      )
      const transport = await attachStalePane(0)
      await vi.advanceTimersByTimeAsync(66_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      const baseline = await registries()
      const timersAtFirstLatch = vi.getTimerCount()
      const subscribesAtFirstLatch = subscribeFrameCount()
      const observed: {
        subscribers: number
        scheduled: number
        timers: number
        revived: number
      }[] = []

      for (let cycle = 0; cycle < 25; cycle += 1) {
        const revived = retryAllRemoteRuntimePtyRecoveriesNow()
        // A second trigger in the same window must find nothing to advance, so an online/resume
        // storm cannot stack fresh recovery epochs on one pane.
        expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(0)
        await vi.advanceTimersByTimeAsync(66_000)
        expect(transport.getRecoveryState?.().phase).toBe('disconnected')
        observed.push({ ...(await registries()), timers: vi.getTimerCount(), revived })
      }

      expect(observed).toEqual(
        Array.from({ length: 25 }, () => ({
          subscribers: baseline.subscribers,
          scheduled: baseline.scheduled,
          timers: timersAtFirstLatch,
          revived: 1
        }))
      )
      // Each revive re-derives the handle; it must not leave extra live stream subscriptions behind.
      expect(subscribeFrameCount()).toBe(subscribesAtFirstLatch)

      transport.destroy?.()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await registries()).toEqual({ subscribers: 0, scheduled: 0 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not stack anything when host snapshots arrive repeatedly at a latched pane', async () => {
    vi.useFakeTimers()
    try {
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
      const transport = await attachStalePane(0)
      await vi.advanceTimersByTimeAsync(66_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const baseline = await registries()

      const subscribesAtLatch = subscribeFrameCount()

      for (let cycle = 0; cycle < 50; cycle += 1) {
        handleEvents.queueAcceptedWebSessionTerminalSnapshot(
          hostSnapshot(10 + cycle, `epoch-${cycle}`),
          'env-1'
        )
        await vi.advanceTimersByTimeAsync(100)
      }

      const after = await registries()
      expect(after.subscribers).toBeLessThanOrEqual(baseline.subscribers)
      expect(after.scheduled).toBeLessThanOrEqual(baseline.scheduled)
      // At most one same-handle resubscribe per spent window: 50 snapshots inside one window
      // must not become 50 subscribes.
      expect(subscribeFrameCount() - subscribesAtLatch).toBeLessThanOrEqual(1)

      transport.destroy?.()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await registries()).toEqual({ subscribers: 0, scheduled: 0 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
