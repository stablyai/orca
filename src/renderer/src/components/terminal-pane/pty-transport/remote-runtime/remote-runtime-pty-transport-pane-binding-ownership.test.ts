import {
  LEAF_1,
  LEAF_2,
  unboundSplitLayout
} from '../../layout/detach/terminal-pane-tab-detach-fixture'
import type { AppState } from '@/store/types'
import type { ConnectPanePtySession } from '../../pty-connection/connect-pane-pty-session'
import './recovery/remote-runtime-pty-recovery-state'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './recovery/remote-runtime-pty-recovery-limits'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

const appStore = vi.hoisted(() => ({
  getState: vi.fn<() => AppState>(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))
// Why: the recovery portals read a pairing-refusal hook this pane-binding test doesn't exercise.
vi.mock('./recovery/use-managed-pairing-refused', () => ({
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
      vi.doMock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
        scheduleRuntimeGraphSync: vi.fn()
      }))
      vi.doMock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
        notifyCodexPaneBoundForStaleSweep: vi.fn()
      }))
      const { createTestStore, seedStore } = await import('@/store/testing/app-store-test-fixture'),
        { makeTab } = await import('@/store/terminals/terminal-tab.test-fixture')
      const { installActivePanePtyBinding } =
        await import('../../pty-connection/lifecycle/active-pane-pty-binding')
      const { installTerminalBellCompletionArbitration } =
        await import('../../pty-connection/notifications/terminal-bell-completion-arbitration')
      const { bindReplacedProcessInputModes } =
        await import('../../pty-connection/output/replaced-process-input-modes')
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
        windowsPtyModel: { apply: vi.fn() },
        setPanePtyFitBinding: vi.fn(),
        registerSideEffectFactConsumerForPty: vi.fn(),
        syncHiddenRendererPtyDelivery: vi.fn(),
        syncPanePtyLayoutBinding: vi.fn(),
        writeInputModeGround: vi.fn(),
        clearPaneMode2031State: vi.fn(),
        agentCompletionCoordinator: { startProcessTracking: vi.fn() }
      } as unknown as ConnectPanePtySession
      installActivePanePtyBinding(session)
      installTerminalBellCompletionArbitration(session)
      bindReplacedProcessInputModes(session)
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
})
