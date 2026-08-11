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
import {
  consumeCommittedPtyShutdownExit,
  deferPtyShutdownExit,
  registerPtyShutdownExitIncarnation
} from '../../components/terminal-pane/pty-shutdown-exit-deferral'
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

  it('retires a backend-stopped stable local PTY without killing a replacement incarnation', async () => {
    const store = createTestStore()
    const stablePtyId = 'pty-stable-owner'
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: stablePtyId })]
      },
      ptyIdsByTabId: { 'tab-1': [stablePtyId] }
    })

    await store.getState().shutdownWorktreeTerminals(worktreeId, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true
    })

    expect(killPty).not.toHaveBeenCalled()
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(store.getState().pendingPtyShutdownIds[stablePtyId]).toBeUndefined()
  })

  it('still kills local PTYs when backend teardown is not opted in', async () => {
    const store = createTestStore()
    const localPtyId = 'local-pty'
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: localPtyId })]
      },
      ptyIdsByTabId: { 'tab-1': [localPtyId] }
    })

    await store
      .getState()
      .shutdownWorktreeTerminals(worktreeId, { shutdownReason: 'remove-worktree' })

    expect(killPty).toHaveBeenCalledWith(localPtyId, { keepHistory: false })
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
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

  it('preserves replacement state when a deletion fence expires during PTY shutdown', async () => {
    const store = createTestStore()
    const localPtyId = 'local-old-pty'
    const replacementPtyId = 'local-replacement-pty'
    const replacementTab = makeTab({
      id: 'replacement-tab',
      worktreeId,
      ptyId: replacementPtyId
    })
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'old-tab', worktreeId, ptyId: localPtyId })]
      },
      ptyIdsByTabId: { 'old-tab': [localPtyId] }
    })
    let current = true

    const shutdown = store.getState().shutdownWorktreeTerminals(worktreeId, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true,
      isCurrent: () => current
    })
    current = false
    store.setState((state) => ({
      tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: [replacementTab] },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        [replacementTab.id]: [replacementPtyId]
      },
      pendingStartupByTabId: {
        ...state.pendingStartupByTabId,
        [replacementTab.id]: { command: 'replacement-command' }
      }
    }))
    await shutdown

    expect(killPty).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([replacementTab])
    expect(store.getState().ptyIdsByTabId[replacementTab.id]).toEqual([replacementPtyId])
    expect(store.getState().pendingStartupByTabId[replacementTab.id]?.command).toBe(
      'replacement-command'
    )
    expect(store.getState().pendingPtyShutdownIds[localPtyId]).toBeUndefined()
  })

  it('does not retain an exit guard for a same-ID replacement after invalidation', async () => {
    const store = createTestStore()
    const stablePtyId = 'local-stable-pty'
    const deferredOldPtyId = 'local-deferred-old-pty'
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'old-tab', worktreeId, ptyId: stablePtyId })]
      },
      ptyIdsByTabId: { 'old-tab': [stablePtyId, deferredOldPtyId] }
    })
    let current = true
    const oldBinding = registerPtyShutdownExitIncarnation(stablePtyId)

    const shutdown = store.getState().shutdownWorktreeTerminals(worktreeId, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true,
      isCurrent: () => current
    })
    const oldExitSettlement = vi.fn()
    deferPtyShutdownExit(deferredOldPtyId, oldExitSettlement)
    const replacementBinding = registerPtyShutdownExitIncarnation(stablePtyId)
    const replacementExitSettlement = vi.fn()
    deferPtyShutdownExit(stablePtyId, replacementExitSettlement, replacementBinding.incarnation)
    current = false
    const replacementTab = makeTab({ id: 'replacement-tab', worktreeId, ptyId: stablePtyId })
    store.setState((state) => ({
      tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: [replacementTab] },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, [replacementTab.id]: [stablePtyId] }
    }))

    await shutdown

    expect(oldExitSettlement).toHaveBeenCalledWith('committed')
    expect(replacementExitSettlement).toHaveBeenCalledWith('unrelated')
    expect(store.getState().suppressedPtyExitIds[stablePtyId]).toBeUndefined()
    expect(consumeCommittedPtyShutdownExit(stablePtyId)).toBe(false)
    expect(store.getState().ptyIdsByTabId[replacementTab.id]).toEqual([stablePtyId])
    oldBinding.unregister()
    replacementBinding.unregister()
  })
})
