import { LEAF_1, LEAF_2, unboundSplitLayout } from './terminal-pane-tab-detach-fixture'
import type { AppState } from '@/store/types'
import type { TerminalPaneController } from './use-terminal-pane-controller'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

// These transport fixtures never read abandoned-launch ownership from the app store.
const appStore = vi.hoisted(() => ({
  getState: vi.fn<() => AppState>(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))
// Why: the recovery portals read a pairing-refusal hook this pane-binding test doesn't exercise.
vi.mock('./use-managed-pairing-refused', () => ({
  useManagedPairingRefusedEnvironmentId: () => null
}))

let composedStore = false
afterEach(() => {
  if (!composedStore) {
    expect(appStore.getState).not.toHaveBeenCalled()
  }
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
  latestSubscribePayload,
  subscribeFrameCount,
  inputFrameTexts,
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

function unreachable(): Error {
  return Object.assign(new Error('Remote Orca runtime closed the connection.'), {
    code: 'remote_runtime_unavailable'
  })
}

const callsTo = (method: string) => runtimeCall.mock.calls.filter(([r]) => r.method === method)

// Every exit from binding a remote pane must leave one owner: the host's answer, or the transport's own retry.
describe('remote runtime pane binding ownership', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
    composedStore = false
  })

  it.each([
    ['terminal-1', 'old-incarnation', 'direct'],
    ['terminal-1', 'new-incarnation', 'close'],
    ['terminal-2', 'new-incarnation', 'end']
  ])(
    'retains one refresh through %s delayed acceptance (%s, %s)',
    async (replacement, nextIncarnation, interruption) => {
      if (interruption === 'close') {
        vi.useFakeTimers()
      }
      composedStore = true
      vi.doMock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
      vi.doMock('@/lib/codex-stale-pane-sweep', () => ({
        notifyCodexPaneBoundForStaleSweep: vi.fn()
      }))
      const { createTestStore, makeTab, seedStore } =
        await import('@/store/slices/store-test-helpers')
      const { installPanePtyVisibilityBind } =
        await import('./pty-connection/pane-pty-visibility-bind')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const store = createTestStore()
      const old = 'remote:env-1@@saved-predecessor'
      const sibling = 'remote:env-1@@sibling'
      const initial = 'remote:env-1@@terminal-1'
      seedStore(store, {
        tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: old })] },
        ptyIdsByTabId: { 'tab-1': [old, sibling] },
        terminalLayoutsByTabId: {
          'tab-1': {
            ...unboundSplitLayout(),
            activeLeafId: LEAF_1,
            ptyIdsByLeafId: { [LEAF_1]: old, [LEAF_2]: sibling }
          }
        }
      })
      appStore.getState.mockImplementation(store.getState)
      let incarnationId = 'old-incarnation'
      let refused = false
      let delayResolution = false
      const delayed = Promise.withResolvers<void>()
      const defaultCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method !== 'terminal.resolvePane') {
          return defaultCall?.(args)
        }
        if (delayResolution) {
          delayResolution = false
          await delayed.promise
        }
        if (!refused) {
          refused = true
          return {
            ok: false,
            error: { code: 'runtime_error', message: 'terminal_pane_owner_changed' }
          }
        }
        return {
          ok: true,
          result: {
            terminal: {
              handle: resolvedPaneHandle,
              worktreeId: 'wt-1',
              tabId: 'tab-1',
              leafId: LEAF_1,
              incarnationId
            }
          }
        }
      })
      const onPtyRebind = vi.fn((id: string, prior: string, incarnation?: string | null) =>
        session.onPtyRebind(id, prior, incarnation)
      )
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: LEAF_1,
        onPtyRebind
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the visibility installer runs; its pane/store/transport dependencies are supplied below.
      const session = {
        pane: { id: 1, leafId: LEAF_1 },
        cacheKey: `tab-1:${LEAF_1}`,
        transport,
        deps: {
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          paneTransportsRef: { current: new Map([[1, transport]]) },
          isVisibleRef: { current: true },
          updateTabPtyId: store.getState().updateTabPtyId
        },
        activePanePtyBinding: old,
        bindProcessExitState: vi.fn(),
        setPanePtyFitBinding: vi.fn(),
        registerSideEffectFactConsumerForPty: vi.fn(),
        syncHiddenRendererPtyDelivery: vi.fn(),
        syncPanePtyLayoutBinding: vi.fn(),
        agentCompletionCoordinator: { startProcessTracking: vi.fn() }
      } as unknown as ConnectPanePtySession
      installPanePtyVisibilityBind(session)
      const onError = vi.fn()
      try {
        transport.attach({ existingPtyId: old, callbacks: { onError } })
        await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
        expect(onPtyRebind).toHaveBeenCalledWith(initial, old, incarnationId)
        emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
        expect(store.getState().terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId).toEqual({
          [LEAF_1]: initial,
          [LEAF_2]: sibling
        })
        expect(store.getState().tabsByWorktree['wt-1'][0].ptyId).toBe(initial)
        expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([initial, sibling])
        expect(session.activePanePtyBinding).toBe(initial)
        expect(session.bindProcessExitState).toHaveBeenCalledWith(initial, old)
        expect(session.agentCompletionCoordinator.startProcessTracking).toHaveBeenCalledOnce()
        expect(onError).not.toHaveBeenCalled()
        const refuse = (streamId: number, callbacks = subscriptionCallbacks) =>
          callbacks?.onResponse({
            ok: true,
            result: {
              type: 'error',
              streamId,
              message: 'terminal_pane_owner_changed'
            }
          })
        const { setDriverForPty, getDriverForPty } =
          await import('@/lib/pane-manager/mobile-driver-state')
        const { setFitOverride, getFitOverrideForPty } =
          await import('@/lib/pane-manager/mobile-fit-overrides')
        const phone = { kind: 'mobile' as const, clientId: 'phone-1' }
        setDriverForPty(initial, phone)
        setFitOverride(initial, 'mobile-fit', 49, 20)
        const firstSubscription = subscriptionCallbacks
        const firstFrameCount = subscribeFrameCount()
        resolvedPaneHandle = replacement
        incarnationId = nextIncarnation
        refuse(latestSubscribePayload().streamId)
        expect(transport.sendInput('old process input', 'driving')).toBe(true)
        await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstSubscription))
        await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(firstFrameCount))
        await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe(replacement))
        const refreshedSubscription = subscriptionCallbacks
        const epoch = transport.getRecoveryState?.().epoch
        const next = `remote:env-1@@${replacement}`
        expect(onPtyRebind).toHaveBeenLastCalledWith(next, initial, incarnationId)
        expect.soft(getDriverForPty(next)).toEqual(phone)
        expect.soft(getFitOverrideForPty(next)).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
        // A real multiplexer interruption must not restore the allowance before acceptance.
        if (interruption !== 'direct') {
          const frameCount = subscribeFrameCount()
          if (interruption === 'close') {
            subscriptionCallbacks?.onClose?.()
          } else {
            subscriptionCallbacks?.onResponse({
              ok: true,
              result: {
                type: 'end',
                streamId: latestSubscribePayload().streamId,
                verdict: 'unverifiable'
              }
            })
          }
          await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(refreshedSubscription))
          await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(frameCount))
          await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe(replacement))
          expect(transport.getRecoveryState?.().epoch).toBe(epoch)
        }
        const unacceptedSubscription = subscriptionCallbacks
        const unacceptedStream = latestSubscribePayload().streamId
        const resolves = callsTo('terminal.resolvePane').length
        refuse(unacceptedStream)
        expect(callsTo('terminal.resolvePane')).toHaveLength(resolves)
        expect(transport.getRecoveryState?.()).toMatchObject({
          phase: 'disconnected',
          reason: 'ownership'
        })
        expect(transport.getPtyId()).toBe(next)
        const frameCount = subscribeFrameCount()
        expect(transport.retryRecovery?.()).toBe(true)
        expect(transport.getRecoveryState?.().epoch).toBe((epoch ?? 0) + 1)
        await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(unacceptedSubscription))
        await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(frameCount))
        await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe(replacement))
        emitSnapshot(latestSubscribePayload().streamId, 'replacement$ ')
        await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
        refuse(unacceptedStream, unacceptedSubscription)
        expect(transport.getRecoveryState?.().phase).toBe('connected')
        if (nextIncarnation !== 'old-incarnation') {
          expect(inputFrameTexts().join('')).not.toContain('old process input')
        }
        setDriverForPty(next, { kind: 'idle' })
        setFitOverride(next, 'desktop-fit', 80, 24)
        if (interruption === 'close') {
          delayResolution = true
          subscriptionCallbacks?.onClose?.()
          await vi.waitFor(() => expect(delayResolution).toBe(false))
          await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)
          const frameCount = subscribeFrameCount()
          expect(transport.getRecoveryState?.().phase).toBe('disconnected')
          expect(transport.retryRecovery?.()).toBe(true)
          await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(frameCount))
          emitSnapshot(latestSubscribePayload().streamId, 'successor$ ')
          await vi.advanceTimersByTimeAsync(20)
          expect(transport.getRecoveryState?.().phase).toBe('connected')
          const rebinds = onPtyRebind.mock.calls.length
          resolvedPaneHandle = 'late-owner'
          delayed.resolve()
          await vi.advanceTimersByTimeAsync(20)
          expect(onPtyRebind).toHaveBeenCalledTimes(rebinds)
          expect(transport.getPtyId()).toBe(next)
          expect(store.getState().terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId?.[LEAF_1]).toBe(
            next
          )
          expect(transport.getRecoveryState?.().phase).toBe('connected')
          expect(subscribeFrameCount()).toBe(frameCount + 1)
        }
        expect(callsTo('terminal.create')).toHaveLength(0)
      } finally {
        transport.destroy?.()
        vi.useRealTimers()
      }
    }
  )

  it.each([false, true])(
    'resolves create refusal without replay (contact loss: %s)',
    async (contactLoss) => {
      vi.useFakeTimers()
      const defaultCall = runtimeCall.getMockImplementation()
      let reachable = !contactLoss
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'terminal.create') {
          return {
            ok: false,
            error: { code: 'runtime_error', message: 'terminal_pane_owner_changed' }
          }
        }
        if (!reachable) {
          throw unreachable()
        }
        return defaultCall?.(args)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      const onError = vi.fn()
      try {
        const connecting = transport.connect({ url: '', callbacks: { onError } })
        if (contactLoss) {
          expect(await connecting).toBeUndefined()
          await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)
          vi.doMock('react-dom', () => ({ createPortal: (element: unknown) => element }))
          vi.doMock('./use-wsl-host-unavailable-reason', () => ({
            useWslHostUnavailableReason: () => null
          }))
          const { TerminalPaneRecoveryPortals } = await import('./TerminalPaneRuntimePortals')
          const portals = TerminalPaneRecoveryPortals({
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only recovery fields are read; the portal and WSL hook are inert rendering dependencies.
            controller: {
              managedPanes: [{ id: 1 }],
              ptyRecoveryStatesByPaneId: { 1: transport.getRecoveryState?.() },
              paneTransportsRef: { current: new Map([[1, transport]]) }
            } as unknown as TerminalPaneController
          })
          const banner = portals?.props.children[0]
          expect(banner?.props.phase).toBe('disconnected')
          reachable = true
          const retryRecovery = transport.retryRecovery
          let accepted: boolean | undefined
          transport.retryRecovery = () => (accepted = retryRecovery?.() ?? false)
          banner?.props.onReconnect()
          expect(accepted).toBe(true)
        }
        await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
        emitSnapshot(latestSubscribePayload().streamId, 'recovered$ ')
        if (!contactLoss) {
          expect(await connecting).toMatchObject({ id: 'remote:env-1@@terminal-1' })
        }
        await vi.advanceTimersByTimeAsync(20)
        expect(transport.isConnected()).toBe(true)
        expect(transport.getRecoveryState?.().phase).toBe('connected')
        expect(onError).not.toHaveBeenCalled()
        expect(callsTo('terminal.create')).toHaveLength(1)
        expect(callsTo('terminal.resolvePane')).toHaveLength(contactLoss ? 2 : 1)
      } finally {
        transport.destroy?.()
        vi.useRealTimers()
      }
    }
  )

  it('settles an attach whose pane the host no longer knows instead of latching in connecting (#21344)', async () => {
    const defaultCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.resolvePane') {
        return { ok: false, error: { code: 'runtime_error', message: 'terminal_not_found' } }
      }
      return defaultCall?.(args)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalled())
    // Why -1: the host answered for its registry, but a restarting host can republish later.
    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', -1)
    expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    expect(transport.ownsRecovery?.()).toBe(false)
    expect(transport.sendInput('typed after close', 'driving')).toBe(false)
  })

  it('retries an attach whose pane lookup lost contact instead of latching in connecting', async () => {
    vi.useFakeTimers()
    try {
      let hostReachable = false
      const defaultCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (!hostReachable) {
          throw unreachable()
        }
        return defaultCall?.(args)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        cols: 80,
        rows: 24,
        callbacks: { onError }
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(transport.getRecoveryState?.().phase).toBe('backoff')
      expect(transport.ownsRecovery?.()).toBe(true)
      expect(onError).not.toHaveBeenCalled()
      // Typed while the host is unreachable: held for this pane's terminal, not dropped (#20802).
      expect(transport.sendInput('echo held', 'driving')).toBe(true)

      hostReachable = true
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
      emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
      await vi.advanceTimersByTimeAsync(20)

      expect(transport.isConnected()).toBe(true)
      expect(transport.getRecoveryState?.().phase).toBe('connected')
      expect(transport.ownsRecovery?.()).toBe(false)
      expect(inputFrameTexts().join('')).toBe('echo held')
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports owning recovery after a recoverable connect failure so the pane is not remounted (#21195)', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation(async () => {
        throw unreachable()
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      const result = await transport.connect({
        url: '',
        sessionId: 'remote:env-1@@',
        callbacks: {}
      })

      expect(result).toBeUndefined()
      expect(transport.getPtyId()).toBeNull()
      expect(transport.ownsRecovery?.()).toBe(true)
      transport.destroy?.()
      expect(transport.ownsRecovery?.()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers acknowledged input typed during a same-terminal recovery once it rebinds (#25784)', async () => {
    const defaultCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'terminal.send'
        ? { ok: true, result: { send: { accepted: true } } }
        : defaultCall?.(args)
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    const firstCallbacks = subscriptionCallbacks

    firstCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote runtime connection closed.'
    })
    expect(transport.isConnected()).toBe(false)
    const accepted = transport.sendInputAccepted?.('git status\r', 'driving')

    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstCallbacks))
    await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')

    await expect(accepted).resolves.toBe(true)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.send',
        params: expect.objectContaining({ terminal: 'terminal-1', text: 'git status\r' })
      })
    )
    transport.destroy?.()
  })

  it('does not close a pane on an inventory that was already in flight before its leaf published (#20923)', async () => {
    let releaseStaleInventory: () => void = () => {}
    const staleInventory = new Promise<void>((resolve) => {
      releaseStaleInventory = resolve
    })
    const siblingOnly = readyHostSessionInventoryResponse('terminal-sibling', 'host-tab-1')
    // Why: rewrite the leaf so only a sibling of the requested pane is present.
    const staleSnapshot = JSON.parse(JSON.stringify(siblingOnly).replaceAll('pane:1', 'pane:2'))
    let listCalls = 0
    const defaultCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) => {
      if (args.method === 'session.tabs.activate') {
        return { ok: true, result: { tabs: [] } }
      }
      if (args.method === 'session.tabs.list') {
        listCalls += 1
        if (listCalls === 1) {
          await staleInventory
          return staleSnapshot
        }
        return readyHostSessionInventoryResponse('terminal-1', 'host-tab-1')
      }
      return defaultCall?.(args)
    })
    const { listRemoteRuntimeSessionTabsDeduped } =
      await import('@/runtime/remote-runtime-session-tabs-inflight')
    // Another pane's inventory request starts before this leaf is published.
    const preexisting = listRemoteRuntimeSessionTabsDeduped({
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      load: async () => {
        const response = await runtimeCall({ method: 'session.tabs.list' })
        return { snapshot: response.result }
      }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      const connected = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(400)
      releaseStaleInventory()
      await preexisting

      await expect(connected).resolves.toMatchObject({ id: 'remote:env-1@@terminal-1' })
      expect(onError).not.toHaveBeenCalledWith('Remote terminal was closed.')
      expect(listCalls).toBeGreaterThanOrEqual(2)
    } finally {
      releaseStaleInventory()
      transport.destroy?.()
      vi.useRealTimers()
    }
  })
})
