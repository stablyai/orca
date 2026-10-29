import { beforeEach, describe, expect, it, vi } from 'vitest'

const unregisterPtyDataHandlers = vi.hoisted(() => vi.fn(() => []))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers
}))

const runtimeCall = vi.fn()
const killPty = vi.fn().mockResolvedValue(undefined)

globalThis.window = {
  api: {
    pty: { kill: killPty },
    runtimeEnvironments: { call: runtimeCall }
  }
} as never

import { getDefaultSettings } from '../../../../shared/constants'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeRuntimeOwnedWorktree, makeTab, seedStore } from './store-test-helpers'

const worktreeId = 'repo1::/srv/worktree'
const ptyId = 'remote:env-1@@pty-1'

function seedRuntimeOwnedWorktree(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' },
    worktreesByRepo: {
      repo1: [
        makeRuntimeOwnedWorktree(
          { id: worktreeId, repoId: 'repo1', path: '/srv/worktree' },
          'env-1'
        )
      ]
    },
    tabsByWorktree: {
      [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId })]
    },
    ptyIdsByTabId: { 'tab-1': [ptyId] }
  })
}

describe('worktree terminal removal teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    runtimeCall.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
  })

  it('retires renderer bindings without stopping the already-removed remote workspace again', async () => {
    const store = createTestStore()
    seedRuntimeOwnedWorktree(store)

    await store.getState().shutdownWorktreeTerminals(worktreeId, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true
    })

    expect(runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.stop')).toHaveLength(
      0
    )
    expect(killPty).not.toHaveBeenCalled()
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(store.getState().pendingPtyShutdownIds[ptyId]).toBeUndefined()
  })

  // Why: the skip is an opt-in for backend-paired removal; a bare call must still kill remote PTYs or they leak with no local trace.
  it('still stops remote terminals when the caller passes no options', async () => {
    const store = createTestStore()
    seedRuntimeOwnedWorktree(store)

    await store.getState().shutdownWorktreeTerminals(worktreeId)

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.stop',
        params: { worktree: `id:${worktreeId}` }
      })
    )
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
  })

  it('still stops remote terminals for an explicit remove reason without the opt-in', async () => {
    const store = createTestStore()
    seedRuntimeOwnedWorktree(store)

    await store
      .getState()
      .shutdownWorktreeTerminals(worktreeId, { shutdownReason: 'remove-worktree' })

    expect(runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.stop')).toHaveLength(
      1
    )
  })
})
