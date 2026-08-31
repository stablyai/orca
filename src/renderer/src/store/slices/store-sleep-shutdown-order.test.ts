import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { createTestStore, makeRuntimeOwnedWorktree, makeTab, seedStore } from './store-test-helpers'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

const orderHarness = vi.hoisted(() => {
  const events: string[] = []
  return {
    events,
    unregister: vi.fn(() => [
      {
        ptyId: 'pty-1',
        commit: () => events.push('handler-commit'),
        rollback: vi.fn()
      }
    ]),
    settleDeferred: vi.fn(() => events.push('deferred-exit-settlement'))
  }
})

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: orderHarness.unregister
}))

vi.mock('@/components/terminal-pane/pty-shutdown-exit-deferral', () => ({
  clearCommittedPtyShutdownSettlements: vi.fn(),
  hasCommittedPtyShutdownSettlement: vi.fn(() => false),
  markCommittedPtyShutdowns: vi.fn(),
  noteCommittedPtyShutdownSettlements: vi.fn(),
  settleDeferredPtyShutdownExits: orderHarness.settleDeferred
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = createStoreCascadesMockApi()

describe('shutdownWorktreeTerminals ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    orderHarness.events.length = 0
    shutdownBufferCaptures.clear()
    applySleepRuntimeRpcDefault(mockApi)
  })

  it('orders capture, guards, handlers, owner stop, renderer kill, commit, cleanup, and exit settlement', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      dropAgentStatusByWorktree: vi.fn(() => orderHarness.events.push('agent-cleanup')),
      clearPaneForegroundAgentByWorktree: vi.fn()
    })
    shutdownBufferCaptures.set('tab-1', () => orderHarness.events.push('buffer-capture'))
    const unsubscribe = store.subscribe((state, previous) => {
      if (!previous.pendingPtyShutdownIds['pty-1'] && state.pendingPtyShutdownIds['pty-1']) {
        orderHarness.events.push('shutdown-guard-publication')
      }
      if (previous.ptyIdsByTabId['tab-1']?.length && state.ptyIdsByTabId['tab-1']?.length === 0) {
        orderHarness.events.push('terminal-state-cleanup')
      }
    })
    orderHarness.unregister.mockImplementationOnce(() => {
      orderHarness.events.push('handler-unregister')
      return [
        {
          ptyId: 'pty-1',
          commit: () => orderHarness.events.push('handler-commit'),
          rollback: vi.fn()
        }
      ]
    })
    mockApi.runtimeEnvironments.call.mockImplementation(async (args: { method: string }) => {
      const compatibilityResponse = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatibilityResponse) {
        return compatibilityResponse
      }
      if (args.method === 'terminal.sleep') {
        orderHarness.events.push('owner-runtime-rpc')
      }
      return {
        id: 'rpc-order',
        ok: true,
        result:
          args.method === 'terminal.sleep'
            ? {
                stopped: 0,
                stoppedPtyIds: [],
                livePtyIds: [],
                postStopVerified: true
              }
            : {},
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    mockApi.pty.kill.mockImplementationOnce(async () => {
      orderHarness.events.push('renderer-kill')
    })

    await store.getState().shutdownWorktreeTerminals(worktreeId, { keepIdentifiers: true })
    expect(orderHarness.events).toEqual([
      'buffer-capture',
      'shutdown-guard-publication',
      'handler-unregister',
      'owner-runtime-rpc',
      'renderer-kill',
      'handler-commit',
      'terminal-state-cleanup',
      'agent-cleanup',
      'deferred-exit-settlement'
    ])
    unsubscribe()
  })
})
