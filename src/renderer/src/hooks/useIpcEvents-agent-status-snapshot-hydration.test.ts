import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../store/testing/app-store-test-fixture'
import { makeTab } from '../store/terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '../store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../store/repos/repo.test-fixture'
import { layoutApplyTestDouble } from '@/runtime/workspace-layout/testing/layout-apply-test-double'
import type { AppState } from '../store/types'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import {
  buildStoreState,
  expectWorktreeRouting,
  FUTURE_LEAF_ID,
  FUTURE_PANE_KEY,
  type AgentStatusSetData,
  type StoreLike,
  type StoreSubscribeListener,
  type MobileFitListener,
  type MobileDriverListener,
  type MobileBrowserDriverListener
} from './ipc-events-agent-status-store-test-fixtures'
import {
  buildWindowApi,
  stubReactSyncEffect,
  stubAuxiliaryModules
} from './ipc-events-agent-status-window-test-fixtures'

describe('useIpcEvents agent status snapshot integration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('clears pending mobile state events and ignores late hydration after cleanup', async () => {
    const setFitOverride = vi.fn()
    const hydrateOverrides = vi.fn()
    const setDriverForPty = vi.fn()
    const hydrateDrivers = vi.fn()
    const setDriverForBrowserPage = vi.fn()
    const hydrateBrowserDrivers = vi.fn()
    const unsubscribeFit = vi.fn()
    const unsubscribeDriver = vi.fn()
    const unsubscribeBrowserDriver = vi.fn()
    const refs: {
      cleanup?: () => void
      fit?: MobileFitListener
      driver?: MobileDriverListener
      browserDriver?: MobileBrowserDriverListener
    } = {}
    let resolveFitOverrides: (value: []) => void = () => {}
    let resolveDrivers: (value: []) => void = () => {}
    let resolveBrowserDrivers: (value: []) => void = () => {}

    vi.doMock('@/lib/pane-manager/mobile-fit-overrides', () => ({
      setFitOverride,
      hydrateOverrides
    }))
    vi.doMock('@/lib/pane-manager/mobile-driver-state', () => ({
      setDriverForPty,
      hydrateDrivers
    }))
    vi.doMock('@/lib/pane-manager/browser-mobile-driver-state', () => ({
      setDriverForBrowserPage,
      hydrateBrowserDrivers
    }))
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
          const result = effect()
          if (typeof result === 'function') {
            refs.cleanup = result
          }
        }
      }
    })
    stubAuxiliaryModules()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => buildStoreState({})
      }
    }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        runtime: {
          getTerminalFitOverrides: () =>
            new Promise<[]>((resolve) => {
              resolveFitOverrides = resolve
            }),
          getTerminalDrivers: () =>
            new Promise<[]>((resolve) => {
              resolveDrivers = resolve
            }),
          getBrowserDrivers: () =>
            new Promise<[]>((resolve) => {
              resolveBrowserDrivers = resolve
            }),
          onTerminalFitOverrideChanged: (listener: MobileFitListener) => {
            refs.fit = listener
            return unsubscribeFit
          },
          onTerminalDriverChanged: (listener: MobileDriverListener) => {
            refs.driver = listener
            return unsubscribeDriver
          },
          onBrowserDriverChanged: (listener: MobileBrowserDriverListener) => {
            refs.browserDriver = listener
            return unsubscribeBrowserDriver
          },
          onClientHostedBrowserRowsChanged: () => () => {},
          getClientHostedBrowserRows: async () => []
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    if (!refs.fit || !refs.driver || !refs.browserDriver || !refs.cleanup) {
      throw new Error('Expected mobile listeners and cleanup to be registered')
    }

    refs.fit({
      ptyId: 'pty-1',
      mode: 'mobile-fit',
      cols: 80,
      rows: 24
    })
    refs.driver({
      ptyId: 'pty-1',
      driver: { kind: 'mobile', clientId: 'phone' }
    })
    refs.browserDriver({
      browserPageId: 'page-1',
      driver: { kind: 'mobile', clientId: 'phone' }
    })

    refs.cleanup()
    resolveFitOverrides([])
    resolveDrivers([])
    resolveBrowserDrivers([])
    await Promise.resolve()
    await Promise.resolve()

    expect(unsubscribeFit).toHaveBeenCalledTimes(1)
    expect(unsubscribeDriver).toHaveBeenCalledTimes(1)
    expect(unsubscribeBrowserDriver).toHaveBeenCalledTimes(1)
    expect(hydrateOverrides).not.toHaveBeenCalled()
    expect(hydrateDrivers).not.toHaveBeenCalled()
    expect(hydrateBrowserDrivers).not.toHaveBeenCalled()
    expect(setFitOverride).not.toHaveBeenCalled()
    expect(setDriverForPty).not.toHaveBeenCalled()
    expect(setDriverForBrowserPage).not.toHaveBeenCalled()
  })

  it('ignores early push events but applies the main-process snapshot after readiness', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: FUTURE_PANE_KEY,
          state: 'working' as const,
          workingMode: 'monitoring' as const,
          prompt: 'p',
          agentType: 'claude',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {},
      workspaceSessionReady: false
    })
    const setAgentStatuses = vi.mocked(storeState.setAgentStatuses as AppState['setAgentStatuses'])

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn((listener: StoreSubscribeListener) => {
          subscribeListenerRef.current = listener
          return () => {
            subscribeListenerRef.current = null
          }
        }),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })
    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(getSnapshot).not.toHaveBeenCalled()

    const previousStoreState = { ...storeState }
    storeState.workspaceSessionReady = true
    storeState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
    }
    storeState.terminalLayoutsByTabId = {
      'tab-future': {
        root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
        activeLeafId: FUTURE_LEAF_ID,
        expandedLeafId: null
      }
    }
    if (typeof subscribeListenerRef.current !== 'function') {
      throw new Error('Expected useAppStore.subscribe listener to be registered')
    }
    subscribeListenerRef.current(storeState, previousStoreState)
    await Promise.resolve()

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatuses).toHaveBeenCalledTimes(1)
    expect(setAgentStatuses.mock.calls[0]?.[0]).toHaveLength(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'working',
        workingMode: 'monitoring',
        prompt: 'p',
        agentType: 'claude'
      }),
      'Future Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('applies a status snapshot to terminal panes after session readiness', async () => {
    const paneCount = 2
    const snapshot: AgentStatusSetData[] = []
    const worktrees: AppState['worktreesByRepo'][string] = []
    const tabsByWorktree: AppState['tabsByWorktree'] = {}
    const unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] = {}
    const terminalLayoutsByTabId: AppState['terminalLayoutsByTabId'] = {}
    for (let index = 0; index < paneCount; index += 1) {
      const worktreeId = `wt-snapshot-${index}`
      const tabId = `tab-snapshot-${index}`
      const leafId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      const paneKey = makePaneKey(tabId, leafId)
      worktrees.push(makeWorktree({ id: worktreeId, repoId: TEST_REPO.id }))
      tabsByWorktree[worktreeId] = [
        makeTab({ id: tabId, worktreeId, title: 'Hermes', ptyId: `pty-${index}` })
      ]
      unifiedTabsByWorktree[worktreeId] = [makeUnifiedTab({ id: tabId, worktreeId, groupId: 'g' })]
      terminalLayoutsByTabId[tabId] = {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null
      }
      snapshot.push({
        paneKey,
        worktreeId,
        state: 'waiting',
        prompt: `remote prompt ${index}`,
        agentType: 'hermes',
        receivedAt: 1_700_000_000_000 + index,
        stateStartedAt: 1_700_000_000_000 + index
      })
    }
    let resolveSnapshot: ((entries: AgentStatusSetData[]) => void) | undefined
    const getSnapshot = vi.fn(
      () =>
        new Promise<AgentStatusSetData[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: worktrees },
      tabsByWorktree,
      terminalLayoutsByTabId,
      activeWorktreeId: worktrees[0]?.id ?? null,
      settings: {
        ...store.getState().settings,
        tabAutoGenerateTitle: true,
        terminalFontSize: 13
      }
    } as Partial<AppState>)
    store.setState({ unifiedTabsByWorktree })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: store.subscribe,
        getState: store.getState,
        setState: store.setState
      }
    }))
    stubAuxiliaryModules()
    const main = layoutApplyTestDouble()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {},
        runtime: { call: main.call }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    resolveSnapshot?.(snapshot)

    await vi.waitFor(() => {
      expect(
        store.getState().agentStatusByPaneKey['tab-snapshot-1:00000000-0000-4000-8000-000000000001']
          ?.state
      ).toBe('waiting')
    })
  })
})
