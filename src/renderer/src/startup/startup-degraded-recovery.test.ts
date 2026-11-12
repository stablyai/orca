// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '../store/testing/app-store-test-fixture'
import { createStoreSessionMockApi } from '../store/testing/app-store-session-api.test-fixture'
import { TEST_REPO } from '../store/repos/repo.test-fixture'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { makeWorktree } from '../store/slices/worktrees/worktree.test-fixture'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../components/terminal/terminal-provider-snapshot-capability', () => ({
  collectTerminalProviderSnapshotPtyIds: () => [],
  refreshTerminalProviderSnapshotCapabilities: async () => undefined
}))
vi.mock('../components/terminal/terminal-provider-gone-sessions', () => ({
  probeTerminalProviderGoneSessions: async () => undefined
}))
const stores = vi.hoisted((): { current: ReturnType<typeof createTestStore> | null } => ({
  current: null
}))
vi.mock('../store', () => ({
  useAppStore: {
    getState: () => stores.current!.getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      stores.current!.setState(...args),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      stores.current!.subscribe(...args)
  }
}))

import { toast } from 'sonner'
import { useAppStore } from '../store'
import type { RuntimeHostStatusSnapshot } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { recoverFromDegradedStartup } from './startup-degraded-recovery'
import '../web/web-runtime-client-error'
import { createRetainedTerminalStartupPreparation } from './retained-terminal-startup-restoration'
import type { TerminalStartupRestoration } from '../../../shared/workspace-layout/retained-terminal-destination'

function retainedDestination(): TerminalStartupRestoration['retainedTerminalStarts'][number] {
  return {
    start: {
      worktreeId: 'repo1::/repo1/main',
      runtimeId: 'runtime-1',
      executionHostId: 'local',
      tabId: 'retained-tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      bindingGeneration: 0,
      startSequence: 1,
      status: 'failed',
      reason: 'The terminal could not start.'
    },
    tab: {
      id: 'retained-tab',
      worktreeId: 'repo1::/repo1/main',
      ptyId: null,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    group: {
      id: 'source',
      worktreeId: 'repo1::/repo1/main',
      activeTabId: 'retained-tab',
      tabOrder: ['retained-tab']
    },
    layout: {
      root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
      activeLeafId: '11111111-1111-4111-8111-111111111111',
      expandedLeafId: null
    }
  }
}

describe('recoverFromDegradedStartup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    createStoreSessionMockApi()
    stores.current = createTestStore()
    seedStore(stores.current, {
      repos: [{ ...TEST_REPO, executionHostId: 'local' }],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: 'repo1::/repo1/main',
            repoId: 'repo1',
            path: '/repo1/main',
            hostId: 'local'
          })
        ]
      },
      groupsByWorktree: {
        'repo1::/repo1/main': [
          { id: 'source', worktreeId: 'repo1::/repo1/main', activeTabId: null, tabOrder: [] }
        ]
      },
      layoutByWorktree: { 'repo1::/repo1/main': { type: 'leaf', groupId: 'source' } }
    })
    useAppStore.setState({ terminalStartupRestorationReady: false, workspaceSessionReady: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          awaitFirstWindowStartupServices: async () => undefined,
          prepareTerminalStartupRestoration: async () => undefined,
          recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined,
          relaunch: vi.fn()
        }
      }
    })
  })

  it('installs retained startup facts before degraded reconnect and reuses them when readiness must be forced', async () => {
    let deliver!: (restoration: TerminalStartupRestoration) => void
    const response = new Promise<TerminalStartupRestoration>((resolve) => {
      deliver = resolve
    })
    let requested!: () => void
    const request = new Promise<void>((resolve) => {
      requested = resolve
    })
    const prepare = vi.fn(() => {
      requested()
      return response
    })
    window.api.app.prepareTerminalStartupRestoration = prepare
    const destination = retainedDestination()
    const terminalStartupRestoration = createRetainedTerminalStartupPreparation(() => false)
    const reconnect = vi.fn(async () => {
      // Reconnect publishes workspaceSessionReady, the first unbound-mount boundary.
      expect(
        useAppStore.getState().terminalPaneStartsByPaneKey[
          'retained-tab:11111111-1111-4111-8111-111111111111'
        ]?.status
      ).toBe('failed')
      useAppStore.setState({ workspaceSessionReady: true })
      throw new Error('reconnect failed after publishing bindings')
    })
    const args = {
      error: new Error('catalog hydration failed'),
      uiHydrated: true,
      reconnectStarted: false,
      terminalStartupRestoration,
      isCancelled: () => false,
      hydratePersistedUI: vi.fn(),
      reconnectPersistedTerminals: reconnect,
      abortSignal: new AbortController().signal
    }
    const recovery = recoverFromDegradedStartup(args)
    await request
    expect(reconnect).not.toHaveBeenCalled()
    expect(useAppStore.getState().workspaceSessionReady).toBe(false)
    deliver({ retainedTerminalStarts: [destination] })
    await recovery

    expect(
      useAppStore.getState().tabsByWorktree['repo1::/repo1/main']?.map((tab) => tab.id)
    ).toEqual(['retained-tab'])
    expect(reconnect).toHaveBeenCalledOnce()
    expect(useAppStore.getState().workspaceSessionReady).toBe(true)
    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(true)
    await terminalStartupRestoration.prepare()
    await recoverFromDegradedStartup({ ...args, reconnectStarted: true })
    expect(prepare).toHaveBeenCalledOnce()
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('keeps automatic startup unknown on a malformed destination and accepts a later complete snapshot with a superseded destination', async () => {
    const prepare = vi.fn(async () => ({ retainedTerminalStarts: [null] }))
    Object.defineProperty(window.api.app, 'prepareTerminalStartupRestoration', {
      configurable: true,
      value: prepare
    })
    const preparation = createRetainedTerminalStartupPreparation(() => false)
    const restored = retainedDestination()
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [restored.start.worktreeId]: [restored.tab] },
      terminalLayoutsByTabId: { [restored.tab.id]: restored.layout },
      tabGroups: { [restored.start.worktreeId]: [restored.group!] },
      tabGroupLayouts: { [restored.start.worktreeId]: { type: 'leaf' as const, groupId: 'source' } }
    }
    useAppStore.getState().hydrateWorkspaceSession(session)
    useAppStore.getState().hydrateTabsSession(session)
    const reconnect = vi.fn(async () => {
      throw new Error('reconnect unavailable')
    })
    await recoverFromDegradedStartup({
      error: new Error('initial hydration failed'),
      uiHydrated: true,
      reconnectStarted: false,
      terminalStartupRestoration: preparation,
      isCancelled: () => false,
      hydratePersistedUI: vi.fn(),
      reconnectPersistedTerminals: reconnect,
      abortSignal: new AbortController().signal
    })
    expect(useAppStore.getState().workspaceSessionReady).toBe(true)
    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(true)
    expect(preparation.isPrepared()).toBe(false)
    expect(useAppStore.getState().hydrationSucceeded).toBe(false)
    expect(
      useAppStore
        .getState()
        .terminalStartupAttempt?.isUnknown(
          restored.start.worktreeId,
          restored.tab.id,
          restored.start.leafId
        )
    ).toBe(true)
    expect(useAppStore.getState().terminalPaneStartsByPaneKey).toEqual({})

    Object.defineProperty(window.api.app, 'prepareTerminalStartupRestoration', {
      value: async () => ({ retainedTerminalStarts: [retainedDestination()] })
    })
    useAppStore.setState({
      closedTerminalTabTombstonesByTabId: {
        'retained-tab': { worktreeId: 'repo1::/repo1/main', closedAt: 1, reason: 'user' }
      }
    })
    await expect(preparation.prepare()).resolves.toBe(true)
    expect(preparation.isPrepared()).toBe(true)
  })

  describe('on the paired web client', () => {
    let statusListener: ((snapshot: RuntimeHostStatusSnapshot) => void) | null
    let currentTransport: RuntimeHostStatusSnapshot['transport']
    const relaunch = vi.fn()

    function snapshot(
      transport: RuntimeHostStatusSnapshot['transport']
    ): RuntimeHostStatusSnapshot {
      return {
        environmentId: 'env-1',
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 0,
        status: null,
        verification: 'unavailable',
        transport
      }
    }

    function recoverFrom(
      error: Error,
      pass: { signal?: AbortSignal; isCancelled?: () => boolean } = {}
    ): Promise<void> {
      return recoverFromDegradedStartup({
        error,
        uiHydrated: true,
        reconnectStarted: false,
        terminalStartupRestoration: createRetainedTerminalStartupPreparation(
          pass.isCancelled ?? (() => false)
        ),
        hydratePersistedUI: vi.fn(),
        abortSignal: pass.signal ?? new AbortController().signal,
        isCancelled: pass.isCancelled ?? (() => false),
        reconnectPersistedTerminals: async () => {
          throw new Error('Could not connect to the remote Orca runtime.')
        }
      })
    }

    beforeEach(() => {
      vi.mocked(toast.error).mockClear()
      relaunch.mockClear()
      statusListener = null
      currentTransport = 'disconnected'
      Reflect.set(window, '__ORCA_WEB_CLIENT__', true)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          app: {
            awaitFirstWindowStartupServices: async () => undefined,
            prepareTerminalStartupRestoration: async () => undefined,
            recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined,
            relaunch
          },
          runtimeEnvironments: {
            getStatusSnapshots: async () => [snapshot(currentTransport)],
            onStatusChanged: (listener: (snapshot: RuntimeHostStatusSnapshot) => void) => {
              statusListener = listener
              return () => {
                statusListener = null
              }
            }
          }
        }
      })
    })

    afterEach(() => {
      Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
    })

    it('stops waiting to reload once its startup pass is torn down', async () => {
      const pass = new AbortController()
      await recoverFrom(new Error('Could not connect to the remote Orca runtime.'), {
        signal: pass.signal
      })
      pass.abort()

      statusListener?.(snapshot('ready'))
      expect(relaunch).not.toHaveBeenCalled()
    })

    it('does not announce or arm a reload for a pass cancelled during the check', async () => {
      let cancelled = false
      const getStatusSnapshots = window.api.runtimeEnvironments.getStatusSnapshots
      window.api.runtimeEnvironments.getStatusSnapshots = async () => {
        cancelled = true
        return getStatusSnapshots()
      }
      await recoverFrom(new Error('Could not connect to the remote Orca runtime.'), {
        isCancelled: () => cancelled
      })

      expect(toast.error).not.toHaveBeenCalled()
      expect(statusListener).toBeNull()
    })
  })
})
