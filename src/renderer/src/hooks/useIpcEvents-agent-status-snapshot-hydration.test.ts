import type { AgentStatusBatchUpdate } from '../store/slices/agent-status'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '@/store/types'

import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '../store/slices/store-test-helpers'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { layoutApplyTestDouble } from '@/runtime/layout-apply-test-double'

import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  FUTURE_LEAF_ID,
  FUTURE_PANE_KEY,
  type AgentStatusSetData,
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

  it('caps pending mobile state events while startup hydration is unresolved', async () => {
    const setFitOverride = vi.fn()
    const hydrateOverrides = vi.fn()
    const setDriverForPty = vi.fn()
    const hydrateDrivers = vi.fn()
    const setDriverForBrowserPage = vi.fn()
    const hydrateBrowserDrivers = vi.fn()
    const listeners: { fit?: MobileFitListener } = {}
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
    stubReactSyncEffect()
    stubAuxiliaryModules()
    const { createTestStore } = await import('../store/slices/store-test-helpers')
    const store = createTestStore()
    vi.doMock('../store', () => ({ useAppStore: store }))
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
            listeners.fit = listener
            return () => {}
          }
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    const emitFit = listeners.fit
    if (!emitFit) {
      throw new Error('Expected fit listener to be registered')
    }
    for (let index = 0; index < 350; index += 1) {
      emitFit({
        ptyId: `pty-${index}`,
        mode: 'mobile-fit',
        cols: 80,
        rows: 24
      })
    }
    expect(setFitOverride).not.toHaveBeenCalled()

    resolveFitOverrides([])
    resolveDrivers([])
    resolveBrowserDrivers([])
    await Promise.resolve()
    await Promise.resolve()

    expect(hydrateOverrides).toHaveBeenCalledWith([])
    expect(hydrateDrivers).toHaveBeenCalledWith([])
    expect(hydrateBrowserDrivers).toHaveBeenCalledWith([])
    expect(setFitOverride).toHaveBeenCalledTimes(300)
    expect(setFitOverride).toHaveBeenNthCalledWith(1, 'pty-50', 'mobile-fit', 80, 24)
    expect(setFitOverride).toHaveBeenLastCalledWith('pty-349', 'mobile-fit', 80, 24)
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
    const { createTestStore } = await import('../store/slices/store-test-helpers')
    const store = createTestStore()
    vi.doMock('../store', () => ({ useAppStore: store }))
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
    const { createTestStore } = await import('../store/slices/store-test-helpers')
    const { getAgentStatusOwner } = await import('../store/agent-status-commit')
    const store = createTestStore()
    const owner = getAgentStatusOwner(store)
    store.setState({ workspaceSessionReady: false })
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
    const transact = store.getState().transactAgentStatuses
    const attempted: AgentStatusBatchUpdate[] = []
    const transactions = vi.fn()
    const instrumentedTransact: typeof transact = (operation) => {
      transactions()
      return transact((transaction) =>
        operation({
          ...transaction,
          apply: (update) => {
            attempted.push(update)
            return transaction.apply(update)
          }
        })
      )
    }
    store.setState({ transactAgentStatuses: instrumentedTransact })
    stubReactSyncEffect()
    vi.doMock('../store', () => ({ useAppStore: store }))
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

    // Early pushes must not enter the canonical owner before readiness.
    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })
    expect(transactions).not.toHaveBeenCalled()
    expect(owner.getState().agentStatusByPaneKey[FUTURE_PANE_KEY]).toBeUndefined()
    expect(getSnapshot).not.toHaveBeenCalled()

    store.setState({
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    await Promise.resolve()

    expect(transactions).toHaveBeenCalledTimes(1)
    expect(attempted).toHaveLength(1)
    expect(attempted[0]).toEqual(
      expect.objectContaining({
        paneKey: FUTURE_PANE_KEY,
        payload: expect.objectContaining({
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'p',
          agentType: 'claude'
        }),
        terminalTitle: 'Future Tab',
        timing: { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
        routing: expect.objectContaining({ worktreeId: 'wt-1' })
      })
    )
    expect(owner.getState().agentStatusByPaneKey[FUTURE_PANE_KEY]).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      prompt: 'p',
      agentType: 'claude',
      updatedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000
    })
  })

  it('applies a large snapshot with one status and bounded title publications', async () => {
    const paneCount = 100
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
        makeTab({ id: tabId, worktreeId, title: 'Pi', ptyId: `pty-${index}` })
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
        agentType: 'pi',
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
    const { createTestStore } = await import('../store/slices/store-test-helpers')
    const { getAgentStatusOwner } = await import('../store/agent-status-commit')
    const { applyAgentStatusPatch } = await import('../store/agent-status-patch')
    const store = createTestStore()
    applyAgentStatusPatch(store, {
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: worktrees },
      tabsByWorktree,
      terminalLayoutsByTabId,
      activeWorktreeId: worktrees[0]?.id ?? null,
      settings: {
        ...(store.getState().settings ?? getDefaultSettings('/tmp')),
        tabAutoGenerateTitle: true,
        terminalFontSize: 13
      }
    })
    applyAgentStatusPatch(store, { unifiedTabsByWorktree })

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
    let relevantPublications = 0
    const { subscribeAgentStatusState } = await import('../store/agent-status')
    const unsubscribe = subscribeAgentStatusState((state, previousState) => {
      if (
        state.agentStatusByPaneKey !== previousState.agentStatusByPaneKey ||
        state.tabsByWorktree !== previousState.tabsByWorktree
      ) {
        relevantPublications += 1
      }
    }, store)
    resolveSnapshot?.(snapshot)

    const renamed = () =>
      main.commands.map((command) => (command.type === 'renameTabs' ? command.renames.length : 0))
    await vi.waitFor(() => {
      expect(Object.keys(getAgentStatusOwner(store).getState().agentStatusByPaneKey)).toHaveLength(
        paneCount
      )
      expect(store.getState().tabsByWorktree['wt-snapshot-99']?.[0]?.title).toBe(
        'Pi - action required'
      )
      // Main derives layout-owner tab titles; its unmodeled frames draw them without renderer writes.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        expect(store.getState().tabsByWorktree['wt-snapshot-99']?.[0]?.generatedTitle).toBeFalsy()
      } else {
        expect(store.getState().tabsByWorktree['wt-snapshot-99']?.[0]?.generatedTitle).toBeTruthy()
      }
    })
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve()
    }

    expect(relevantPublications).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? 2 : 3)
    unsubscribe()
    expect(renamed()).toEqual([])
  })

  it('indexes one 100-pane tab and its split tree once per snapshot', async () => {
    const paneCount = 100
    const tabId = 'tab-indexed-snapshot'
    const worktreeId = 'wt-indexed-snapshot'
    const leafIds = Array.from(
      { length: paneCount },
      (_, index) => `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`
    )
    let leafIdLookupCount = 0
    const leaves = leafIds.map((leafId) => {
      const leaf = { type: 'leaf' } as TerminalPaneLayoutNode
      Object.defineProperty(leaf, 'leafId', {
        enumerable: true,
        get: () => {
          leafIdLookupCount += 1
          return leafId
        }
      })
      return leaf
    })
    const root = leaves
      .slice(1)
      .reduce<TerminalPaneLayoutNode>(
        (tree, leaf) => ({ type: 'split', direction: 'vertical', first: tree, second: leaf }),
        leaves[0]!
      )
    let tabIdLookupCount = 0
    const tab = makeTab({ id: tabId, worktreeId, title: 'Workspace', ptyId: 'pty-indexed' })
    Object.defineProperty(tab, 'id', {
      enumerable: true,
      get: () => {
        tabIdLookupCount += 1
        return tabId
      }
    })
    const snapshot = leafIds.map((leafId, index): AgentStatusSetData => ({
      paneKey: makePaneKey(tabId, leafId),
      worktreeId,
      state: 'working',
      prompt: `indexed prompt ${index}`,
      agentType: 'claude',
      receivedAt: 1_700_000_000_000 + index,
      stateStartedAt: 1_700_000_000_000 + index
    }))
    let resolveSnapshot!: (entries: AgentStatusSetData[]) => void
    const getSnapshot = vi.fn(
      () =>
        new Promise<AgentStatusSetData[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const { createTestStore } = await import('../store/slices/store-test-helpers')
    const { getAgentStatusOwner } = await import('../store/agent-status-commit')
    const { applyAgentStatusPatch } = await import('../store/agent-status-patch')
    const store = createTestStore()
    applyAgentStatusPatch(store, {
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: worktreeId, repoId: TEST_REPO.id })]
      },
      tabsByWorktree: { [worktreeId]: [tab] },
      terminalLayoutsByTabId: {
        [tabId]: {
          root,
          activeLeafId: leafIds[0]!,
          expandedLeafId: null
        }
      },
      setGeneratedTabTitlesFromAgentPrompts: vi.fn(),
      settings: {
        ...(store.getState().settings ?? getDefaultSettings('/tmp')),
        terminalFontSize: 13
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: store.subscribe,
        getState: store.getState,
        setState: store.setState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal('window', buildWindowApi({ getSnapshot, onSet: () => () => {} }))

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    tabIdLookupCount = 0
    leafIdLookupCount = 0
    resolveSnapshot(snapshot)

    await vi.waitFor(() => {
      expect(Object.keys(getAgentStatusOwner(store).getState().agentStatusByPaneKey)).toHaveLength(
        paneCount
      )
    })
    expect(tabIdLookupCount).toBe(1)
    expect(leafIdLookupCount).toBe(paneCount)
  })

  it('indexes 100 distinct tab owners once per snapshot', async () => {
    const paneCount = 100
    const worktreeId = 'wt-indexed-tabs'
    const tabs: AppState['tabsByWorktree'][string] = []
    const snapshot: AgentStatusSetData[] = []
    const unsupportedSnapshot: MigrationUnsupportedPtyEntry[] = []
    let tabIdLookupCount = 0
    for (let index = 0; index < paneCount; index += 1) {
      const tabId = `tab-indexed-${index}`
      const leafId = `00000000-0000-4000-8003-${String(index).padStart(12, '0')}`
      const tab = makeTab({
        id: tabId,
        worktreeId,
        title: 'Workspace',
        ptyId: `pty-indexed-${index}`
      })
      Object.defineProperty(tab, 'id', {
        enumerable: true,
        get: () => {
          tabIdLookupCount += 1
          return tabId
        }
      })
      tabs.push(tab)
      snapshot.push({
        paneKey: makePaneKey(tabId, leafId),
        worktreeId,
        state: 'working',
        prompt: `indexed tab prompt ${index}`,
        agentType: 'claude',
        receivedAt: 1_700_000_000_500 + index,
        stateStartedAt: 1_700_000_000_500 + index
      })
      unsupportedSnapshot.push({
        ptyId: `pty-indexed-${index}`,
        worktreeId,
        tabId,
        leafId,
        paneKey: makePaneKey(tabId, leafId),
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: 1_700_000_000_500 + index
      })
    }
    let resolveSnapshot!: (entries: AgentStatusSetData[]) => void
    const getSnapshot = vi.fn(
      () =>
        new Promise<AgentStatusSetData[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    let resolveUnsupportedSnapshot!: (entries: MigrationUnsupportedPtyEntry[]) => void
    const getMigrationUnsupportedSnapshot = vi.fn(
      () =>
        new Promise<MigrationUnsupportedPtyEntry[]>((resolve) => {
          resolveUnsupportedSnapshot = resolve
        })
    )
    const { createTestStore } = await import('../store/slices/store-test-helpers')
    const { getAgentStatusOwner } = await import('../store/agent-status-commit')
    const { applyAgentStatusPatch } = await import('../store/agent-status-patch')
    const store = createTestStore()
    applyAgentStatusPatch(store, {
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: worktreeId, repoId: TEST_REPO.id })]
      },
      tabsByWorktree: { [worktreeId]: tabs },
      terminalLayoutsByTabId: {},
      setGeneratedTabTitlesFromAgentPrompts: vi.fn(),
      settings: {
        ...(store.getState().settings ?? getDefaultSettings('/tmp')),
        terminalFontSize: 13,
        tabAutoGenerateTitle: false
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: store.subscribe,
        getState: store.getState,
        setState: store.setState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        getMigrationUnsupportedSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    tabIdLookupCount = 0
    resolveSnapshot(snapshot)

    await vi.waitFor(() => {
      expect(Object.keys(getAgentStatusOwner(store).getState().agentStatusByPaneKey)).toHaveLength(
        paneCount
      )
    })
    expect(tabIdLookupCount).toBe(paneCount)
    expect(getMigrationUnsupportedSnapshot).toHaveBeenCalledTimes(1)

    // Repeated snapshots with unchanged tabs must reuse the ownership index.
    tabIdLookupCount = 0
    resolveUnsupportedSnapshot(unsupportedSnapshot)
    await vi.waitFor(() => {
      expect(Object.keys(store.getState().migrationUnsupportedByPtyId)).toHaveLength(paneCount)
    })
    expect(tabIdLookupCount).toBe(0)
  })
})
