// @vitest-environment happy-dom
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import { parseWorkspaceSessionSalvaging } from '../../../../shared/workspace-session-salvage'
import { classifyHostStampedTerminal } from '@/lib/terminal-worktree-route'
import { buildHydratedTabState } from '@/store/slices/tabs-hydration'
import { createTestStore, makeWorktree } from '@/store/slices/store-test-helpers'
import { PaneManager, type ManagedPane } from '@/lib/pane-manager/pane-manager'
import { flushAsyncTicks } from './pty-connection-test-async'
import { LEAF_1, createMockTransport } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import type { PtyConnectionDeps } from './pty-connection-types'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

type HostFixtureState = StoreState & {
  worktreesByRepo: Record<
    string,
    { id: string; repoId: string; path: string; projectId?: string }[]
  >
  projectHostSetups: {
    id: string
    projectId: string
    hostId: string
    repoId: string
    path: string
    setupState: string
  }[]
  unifiedTabsByWorktree: Record<
    string,
    {
      id: string
      entityId?: string
      groupId?: string
      worktreeId: string
      contentType: string
      executionHostId?: string
      projectHostSetupId?: unknown
    }[]
  >
}

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function hostDeps(overrides: Partial<PtyConnectionDeps> = {}): PtyConnectionDeps {
  const base = buildPaneConnectionDeps(() => mockStoreState)
  return {
    tabId: base.tabId,
    worktreeId: base.worktreeId,
    cwd: base.cwd,
    mountFollowsTerminalPark: base.mountFollowsTerminalPark,
    paneTransportsRef: { current: new Map() },
    paneMode2031Ref: { current: new Map() },
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onAgentExitedRef: { current: vi.fn() },
    onPtyErrorRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: () => false,
    isPtyShutdownPending: () => false,
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: base.updateTabPtyId,
    markTerminalBell: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    dispatchNotification: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: (paneId, ptyId) => {
      if (ptyId !== null) {
        base.syncPanePtyLayoutBinding(paneId, ptyId)
      }
    },
    clearExitedPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}

const hostPanes: ManagedPane[] = []
const hostManagers: PaneManager[] = []

function disposePane(pane: ManagedPane): void {
  pane.terminal.dispose()
  pane.fitAddon.dispose()
  pane.searchAddon.dispose()
  pane.serializeAddon.dispose()
}

function hostPane(paneId: number): ManagedPane {
  if (!isTerminalLeafId(LEAF_1)) {
    throw new Error('Expected a valid fixture leaf id')
  }
  const terminal = new Terminal({
    cols: 120,
    rows: 40,
    allowProposedApi: true,
    scrollback: 5_000,
    ignoreBracketedPasteMode: false,
    theme: { foreground: '#eeeeee', background: '#111111' },
    vtExtensions: { kittyKeyboard: true }
  })
  // The original fixture only completes a parse callback for an empty write or runParsedSteps.
  vi.spyOn(terminal, 'write').mockImplementation((data, callback) => {
    if (data === '' || callback?.name === 'runParsedSteps') {
      callback?.()
    }
  })
  const fitAddon = new FitAddon()
  vi.spyOn(fitAddon, 'fit').mockImplementation(() => {})
  vi.spyOn(fitAddon, 'proposeDimensions').mockImplementation(() => ({
    cols: terminal.cols,
    rows: terminal.rows
  }))
  const pane: ManagedPane = {
    id: paneId,
    leafId: LEAF_1,
    stablePaneId: LEAF_1,
    terminal,
    container: document.createElement('div'),
    linkTooltip: document.createElement('div'),
    fitAddon,
    searchAddon: new SearchAddon(),
    serializeAddon: new SerializeAddon()
  }
  hostPanes.push(pane)
  return pane
}

function hostManager(pane: ManagedPane): PaneManager {
  const manager = new PaneManager(document.createElement('div'), { linkOpenHint: () => '' })
  hostManagers.push(manager)
  let activePaneId: number | null = null
  vi.spyOn(manager, 'getPanes').mockReturnValue([pane])
  vi.spyOn(manager, 'getActivePane').mockImplementation(() =>
    activePaneId === pane.id ? pane : null
  )
  vi.spyOn(manager, 'getLeafId').mockReturnValue(pane.leafId)
  vi.spyOn(manager, 'getNumericIdForLeaf').mockImplementation((leafId) =>
    leafId === pane.leafId ? pane.id : null
  )
  vi.spyOn(manager, 'hasWebglRenderer').mockReturnValue(false)
  vi.spyOn(manager, 'setPaneGpuRendering').mockImplementation(() => {})
  vi.spyOn(manager, 'markPaneHasComplexScriptOutput').mockImplementation(() => {})
  vi.spyOn(manager, 'setActivePane').mockImplementation((paneId) => {
    activePaneId = paneId
  })
  vi.spyOn(manager, 'rebuildPaneWebgl').mockImplementation(() => {})
  vi.spyOn(manager, 'closePane').mockImplementation(() => {})
  return manager
}

describe('connectPanePty for a host-stamped terminal tab', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    for (const manager of hostManagers.splice(0)) {
      manager.destroy()
    }
    for (const pane of hostPanes.splice(0)) {
      disposePane(pane)
    }
    await restoreTerminalTestGlobals()
  })

  const OWNED = 'remote:env-b@@handle-1'

  function hostStampedState(overrides: Partial<HostFixtureState> = {}): HostFixtureState {
    return {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: OWNED }] },
      ptyIdsByTabId: { 'tab-1': [OWNED] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', projectId: 'project-1' }]
      },
      repos: [
        {
          id: 'repo1',
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          connectionId: null,
          displayName: 'orca'
        }
      ],
      runtimeEnvironments: [{ id: 'env-b' }],
      runtimeEnvironmentCatalogHydrated: true,
      projectHostSetups: [
        {
          id: 'setup-b',
          projectId: 'project-1',
          hostId: 'runtime:env-b',
          repoId: 'repo1',
          path: '/srv/project',
          setupState: 'ready'
        }
      ],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'terminal',
            executionHostId: 'runtime:env-b',
            projectHostSetupId: 'setup-b'
          }
        ]
      },
      ...overrides
    }
  }

  async function connect(
    ptyId: string | null = OWNED,
    overrides: Partial<PtyConnectionDeps> = {},
    paneId = 1
  ): Promise<void> {
    const { connectPanePty } = await import('./pty-connection')
    const pane = hostPane(paneId)
    connectPanePty(
      pane,
      hostManager(pane),
      hostDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: ptyId === null ? {} : { [LEAF_1]: ptyId },
        ...overrides
      })
    )
  }

  /** Connects one pane and returns every error line it surfaced. */
  async function connectForErrors(paneId = 1): Promise<string[]> {
    const onPtyError = vi.fn()
    await connect(OWNED, { onPtyErrorRef: { current: onPtyError } }, paneId)
    await flushAsyncTicks()
    return onPtyError.mock.calls.map(([, message]) => String(message))
  }

  const LOADING = 'Workspace host is still loading. Retry when the project finishes hydrating.'
  const AMBIGUOUS = 'Workspace identity is ambiguous across hosts. Refresh projects and try again.'

  /** The parked-tab selector's view of the fixture's source worktree, typed as the store's. */
  function parkedSelectorState() {
    return {
      ...createTestStore().getState(),
      repos: [{ id: 'repo1', path: '/tmp', displayName: 'orca', badgeColor: '#000', addedAt: 1 }],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1' })]
      },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            ptyId: OWNED,
            worktreeId: 'wt-1',
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': [OWNED] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'terminal' as const,
            executionHostId: 'runtime:env-b' as const,
            projectHostSetupId: 'setup-b',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    }
  }

  // This app's own catalog loads before session hydration, so the source's local setup is known.
  const LOCAL_SETUP = {
    id: 'setup-local',
    projectId: 'project-1',
    hostId: 'local',
    repoId: 'repo1',
    path: '/tmp/wt-1',
    setupState: 'ready'
  }

  // As restored at startup: the saved PTY id is on the tab and leaf, but nothing is live yet, and
  // the stamped host's catalog has not answered.
  function restoredBeforeCatalog(overrides: Partial<HostFixtureState> = {}): HostFixtureState {
    return hostStampedState({ ptyIdsByTabId: {}, projectHostSetups: [LOCAL_SETUP], ...overrides })
  }

  it('parks a stamped tab restored before its host catalog, then reattaches its saved handle', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { getTabIdsAwaitingHostHydrationRemount } =
      await import('@/lib/parked-terminal-host-hydration')
    const state = restoredBeforeCatalog()
    mockStoreState = state

    expect(await connectForErrors()).toEqual([LOADING])
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).not.toHaveBeenCalled()

    // The host's catalog lands with the stamped setup; the native remount picks the parked tab.
    const answered = {
      ...state,
      projectHostSetups: [LOCAL_SETUP, ...hostStampedState().projectHostSetups]
    }
    mockStoreState = answered
    expect(getTabIdsAwaitingHostHydrationRemount(parkedSelectorState())).toEqual(['tab-1'])

    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    expect(await connectForErrors(2)).toEqual([])
    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-b', expect.any(Object))
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(createdTransportOptions.at(-1)).toMatchObject({
      hostTerminalTarget: {
        targetWorktreeSelector: 'path:/srv/project',
        projectHostSetupId: 'setup-b'
      }
    })
    // The same saved handle is attached; nothing is created or re-run.
    expect(transport.attach).toHaveBeenCalledWith(expect.objectContaining({ existingPtyId: OWNED }))
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('never selects a stamped tab that attached for a remount', async () => {
    const { getTabIdsAwaitingHostHydrationRemount } =
      await import('@/lib/parked-terminal-host-hydration')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = hostStampedState({ ptyIdsByTabId: {} })

    expect(await connectForErrors()).toEqual([])
    expect(transport.attach).toHaveBeenCalledWith(expect.objectContaining({ existingPtyId: OWNED }))
    // Live and stamped, but it never parked, so the catalog-refresh remount leaves it alone.
    expect(getTabIdsAwaitingHostHydrationRemount(parkedSelectorState())).toEqual([])
  })

  it('keeps a stamped tab parked while the saved-host list is still loading', async () => {
    mockStoreState = restoredBeforeCatalog({
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: false
    })

    expect(await connectForErrors()).toEqual([LOADING])
  })

  it('leaves a stamped tab of a removed host inert and unparked, never local', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { getTabIdsAwaitingHostHydrationRemount } =
      await import('@/lib/parked-terminal-host-hydration')
    const state = restoredBeforeCatalog({ runtimeEnvironments: [] })
    mockStoreState = state

    expect(await connectForErrors()).toEqual([AMBIGUOUS])
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(getTabIdsAwaitingHostHydrationRemount(parkedSelectorState())).toEqual([])
  })

  it('keeps an ordinary pinned remote project tab on its runtime without parking', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = hostStampedState({
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/srv/wt-1', hostId: 'runtime:env-b' }]
      },
      unifiedTabsByWorktree: {}
    })

    expect(await connectForErrors()).toEqual([])
    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-b', expect.any(Object))
    expect(transport.attach).toHaveBeenCalledWith(expect.objectContaining({ existingPtyId: OWNED }))
  })

  it('reattaches the returned PTY on its stamped runtime with the target selector', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = hostStampedState()

    await connect()
    await flushAsyncTicks()

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-b', expect.any(Object))
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(createdTransportOptions[0]).toMatchObject({
      executionHostId: 'runtime:env-b',
      worktreeId: 'wt-1',
      hostTerminalTarget: {
        targetWorktreeSelector: 'path:/srv/project',
        projectHostSetupId: 'setup-b'
      }
    })
    expect(createdTransportOptions[0]?.cwdFallback).toBeUndefined()
    expect(transport.attach).toHaveBeenCalledWith(expect.objectContaining({ existingPtyId: OWNED }))
    expect(transport.connect).not.toHaveBeenCalled()
  })

  const UNROUTABLE_STATES: [string, string | null, Partial<HostFixtureState>][] = [
    ['an ownerless remote PTY', 'remote:handle-1', {}],
    ['a local PTY', 'pty-local-1', {}],
    ['a foreign remote PTY', 'remote:env-c@@handle-1', {}],
    [
      'an ownerless source repo',
      OWNED,
      { repos: [{ id: 'repo1', connectionId: null, displayName: 'orca' }] }
    ],
    ['a setup that is not ready', OWNED, { projectHostSetups: [] }],
    [
      'a runtime-owned source',
      OWNED,
      {
        worktreesByRepo: {
          repo1: [
            { id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', runtimeOwnerEnvironmentId: 'hub' }
          ]
        }
      }
    ],
    [
      'an invalid host stamp',
      OWNED,
      {
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              worktreeId: 'wt-1',
              contentType: 'terminal',
              executionHostId: 'local',
              projectHostSetupId: 'setup-b'
            }
          ]
        }
      }
    ],
    ...([42, null, '', '  '] as const).map((setup): [string, string, Partial<HostFixtureState>] => [
      `a restored ${JSON.stringify(setup)} setup stamp`,
      OWNED,
      {
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              worktreeId: 'wt-1',
              contentType: 'terminal',
              executionHostId: 'runtime:env-b',
              projectHostSetupId: setup
            }
          ]
        }
      }
    ]),
    [
      'a restored stamp whose unreadable host was dropped',
      OWNED,
      {
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              worktreeId: 'wt-1',
              contentType: 'terminal',
              projectHostSetupId: 'setup-b'
            }
          ]
        }
      }
    ]
  ]

  it.each(UNROUTABLE_STATES)(
    'fails closed with %s, never through the local provider',
    async (_label, ptyId, overrides) => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('./pty-transport')
      mockStoreState = hostStampedState({
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ...overrides
      })

      await connect(ptyId)
      await flushAsyncTicks()

      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createIpcPtyTransport).not.toHaveBeenCalled()
    }
  )

  // D27b: a corrupt setup restored from disk keeps its stamp. z.json() drops an own `__proto__` key,
  // so the setup comes back normalized, and the entry still refuses instead of running anywhere.
  const PROTO_SETUPS: [string, string, string][] = [
    ['at the root', '{"__proto__":{"x":true}}', '{}'],
    ['in a nested object', '{"a":{"__proto__":{"y":1}}}', '{"a":{}}'],
    ['under an array', '[{"__proto__":1}]', '[{}]']
  ]

  /** A saved session as disk JSON text, with `setupText` spliced in raw as the tab's setup. */
  function savedSessionText(setupText: string): string {
    const createdAt = 1_700_000_000_000
    const session = {
      activeRepoId: null,
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-1',
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            ptyId: OWNED,
            worktreeId: 'wt-1',
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt
          }
        ]
      },
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        'wt-1': [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            executionHostId: 'runtime:env-b',
            projectHostSetupId: 'SETUP_PLACEHOLDER',
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt
          }
        ]
      },
      tabGroups: {
        'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      }
    }
    return JSON.stringify(session).replace('"SETUP_PLACEHOLDER"', setupText)
  }

  it.each(PROTO_SETUPS)(
    'restores a stamp whose setup holds an own __proto__ key %s as refused, never local',
    async (_label, setupText, normalized) => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('./pty-transport')
      const text = savedSessionText(setupText)
      expect(text).toContain(`"projectHostSetupId":${setupText}`)

      const parsed = parseWorkspaceSessionSalvaging(JSON.parse(text))
      if (!parsed.ok) {
        throw new Error(`saved session did not parse: ${parsed.error}`)
      }
      expect(parsed.droppedCount).toBe(0)
      const entry = parsed.value.unifiedTabs?.['wt-1']?.[0]
      expect(entry).toMatchObject({ id: 'tab-1', executionHostId: 'runtime:env-b' })
      expect(entry).toHaveProperty('projectHostSetupId')
      expect(JSON.stringify(entry?.projectHostSetupId)).toBe(normalized)
      const rows = parsed.value.tabsByWorktree['wt-1'] ?? []
      expect(rows.map((row) => row.ptyId)).toEqual([OWNED])

      // The window's restore and main's layout load/save both keep the stamp as parsed.
      const hydrated = buildHydratedTabState(parsed.value, new Set(['wt-1']))
      const saved = saveWorkspaceLayout(
        loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, parsed.value, nameBasedLoadContext())
      )
      for (const tabs of [hydrated.unifiedTabsByWorktree['wt-1'], saved.unifiedTabs?.['wt-1']]) {
        expect(tabs).toHaveLength(1)
        expect(tabs?.[0]).toMatchObject({ id: 'tab-1', executionHostId: 'runtime:env-b' })
        expect(JSON.stringify(tabs?.[0]?.projectHostSetupId)).toBe(normalized)
      }
      expect(classifyHostStampedTerminal(hydrated.unifiedTabsByWorktree['wt-1'], 'tab-1')).toEqual({
        kind: 'invalid',
        reason: 'missing_setup'
      })

      mockStoreState = hostStampedState({
        tabsByWorktree: { 'wt-1': rows },
        unifiedTabsByWorktree: hydrated.unifiedTabsByWorktree
      })
      await connect(OWNED)
      await flushAsyncTicks()

      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createIpcPtyTransport).not.toHaveBeenCalled()
    }
  )

  it('keeps an unstamped local terminal on the local provider without a host target', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    transportFactoryQueue.push(createMockTransport('pty-local-1'))
    mockStoreState = hostStampedState({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-local-1' }] },
      repos: [{ id: 'repo1', connectionId: null, displayName: 'orca', executionHostId: 'local' }],
      unifiedTabsByWorktree: {}
    })

    await connect('pty-local-1')
    await flushAsyncTicks()

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).toHaveBeenCalled()
    expect(createdTransportOptions[0]?.executionHostId).toBe('local')
    expect(createdTransportOptions[0]).not.toHaveProperty('hostTerminalTarget')
  })
})
