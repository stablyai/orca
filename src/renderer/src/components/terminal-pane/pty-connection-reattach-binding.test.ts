import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEagerPtyBufferHandle } from './pty-dispatcher'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  LEAF_1,
  LEAF_2,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
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

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

describe('connectPanePty', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('reattaches a remounted split pane to its restored leaf PTY instead of the tab-level PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'leaf-pty-2' }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    // Why: deferred reattach uses connect({ sessionId }) not attach() so the daemon's createOrAttach runs at the pane's real fitAddon dimensions.
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'leaf-pty-2' })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'leaf-pty-2')
    // Why: a pane that outlived the app reaches its PTY only through this
    // restored-session reattach, so the stale-account sweep must be queued here
    // too — the fresh-spawn chokepoint never runs for it.
    expect(notifyCodexPaneBoundForStaleSweep).toHaveBeenCalledWith('leaf-pty-2')
  })

  it('publishes async layout bindings by the pane leaf, not a remapped numeric id', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const syncPanePtyLayoutBindingForLeaf = vi.fn()
    const manager = createManager(1)
    // A successor manager can reuse the numeric slot for a different leaf
    // while an older callback is still settling.
    manager.getPanes.mockReturnValue([{ id: 1, leafId: LEAF_2 }])
    const deps = createDeps({ syncPanePtyLayoutBindingForLeaf })
    const pane = createPane(1)

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(12)

    expect(syncPanePtyLayoutBindingForLeaf).toHaveBeenCalledWith(LEAF_1, 'tab-pty', 1)
    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalled()
  })

  it('does not publish a stale layout callback after a successor transport takes the pane slot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<{ id: string; isReattach: true }>()
    const staleTransport = createMockTransport('terminal-old')
    staleTransport.connect.mockImplementation(async () => reattach.promise)
    transportFactoryQueue.push(staleTransport)
    const syncPanePtyLayoutBindingForLeaf = vi.fn()
    const paneTransportsRef = { current: new Map<number, MockTransport>() }
    const deps = createDeps({ paneTransportsRef, syncPanePtyLayoutBindingForLeaf })
    const pane = createPane(1)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      Object.assign(deps, {
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'terminal-old' }
      }) as never
    )
    await flushAsyncTicks(8)
    const callsBeforeReplacement = syncPanePtyLayoutBindingForLeaf.mock.calls.length
    paneTransportsRef.current.set(pane.id, createMockTransport('terminal-successor'))
    reattach.resolve({ id: 'terminal-new', isReattach: true })
    await flushAsyncTicks(16)

    expect(syncPanePtyLayoutBindingForLeaf).toHaveBeenCalledTimes(callsBeforeReplacement)
  })

  it('does not clear a successor pane error from a stale stream callback', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const staleTransport = createMockTransport('terminal-old')
    let callbacks: ConnectCallbacks | undefined
    staleTransport.connect.mockImplementation(async (options) => {
      callbacks = options.callbacks
      return { id: 'terminal-old', isReattach: true }
    })
    transportFactoryQueue.push(staleTransport)
    const paneTransportsRef = { current: new Map<number, MockTransport>() }
    const onPtyErrorCleared = vi.fn()
    const deps = createDeps({
      paneTransportsRef,
      onPtyErrorClearedRef: { current: onPtyErrorCleared }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(12)
    expect(callbacks?.onErrorCleared).toBeDefined()

    paneTransportsRef.current.set(1, createMockTransport('terminal-successor'))
    callbacks?.onErrorCleared?.('stale stream')

    expect(onPtyErrorCleared).not.toHaveBeenCalled()
  })

  it('does not clear a successor pane error when a stale binding is disposed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const staleTransport = createMockTransport('terminal-old')
    transportFactoryQueue.push(staleTransport)
    const paneTransportsRef = { current: new Map<number, MockTransport>() }
    const onPtyErrorCleared = vi.fn()
    const deps = createDeps({
      paneTransportsRef,
      onPtyErrorClearedRef: { current: onPtyErrorCleared }
    })

    const binding = connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(12)

    paneTransportsRef.current.set(1, createMockTransport('terminal-successor'))
    binding.dispose()

    expect(onPtyErrorCleared).not.toHaveBeenCalled()
  })

  it('does not spend queued startup from a stale spawn callback', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const staleTransport = createMockTransport()
    transportFactoryQueue.push(staleTransport)
    const paneTransportsRef = { current: new Map<number, MockTransport>() }
    const onStartupBound = vi.fn()
    const startup = { command: 'echo queued-startup' }
    const deps = createDeps({ paneTransportsRef, startup, onStartupBound })
    const binding = connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(12)

    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    paneTransportsRef.current.set(1, createMockTransport('terminal-successor'))
    onPtySpawn?.('stale-pty')

    expect(onStartupBound).not.toHaveBeenCalled()
    binding.dispose()
  })

  it('resizes a reattached PTY to the current grid when the pane narrows before reattach resolves', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<void>()
    let currentPtyId: string | null = null
    const transport = createMockTransport()
    transport.getPtyId.mockImplementation(() => currentPtyId)
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      currentPtyId = sessionId ?? null
      await reattach.promise
      return sessionId ? { id: sessionId } : null
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(2)
    pane.terminal.cols = 133
    pane.terminal.rows = 63
    let proposedGrid = { cols: 133, rows: 63 }
    ;(
      pane.fitAddon as unknown as {
        proposeDimensions: () => { cols: number; rows: number }
      }
    ).proposeDimensions = vi.fn(() => proposedGrid)
    pane.fitAddon.fit = vi.fn(() => {
      pane.terminal.cols = proposedGrid.cols
      pane.terminal.rows = proposedGrid.rows
    })
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'leaf-pty-2' }
    })

    connectPanePty(pane as never, createManager(2) as never, deps as never)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 133, rows: 63, sessionId: 'leaf-pty-2' })
    )

    proposedGrid = { cols: 65, rows: 63 }
    reattach.resolve()
    await flushAsyncTicks()

    expect(transport.resize).toHaveBeenCalledWith(65, 63)
    expect(transport.resize).toHaveBeenLastCalledWith(65, 63, { claim: true })
  })

  it('does not let a stale pane transport publish a completed reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<{ id: string; isReattach: true }>()
    const staleTransport = createMockTransport()
    let stalePtyId: string | null = 'terminal-old'
    staleTransport.getPtyId.mockImplementation(() => stalePtyId)
    staleTransport.connect.mockImplementation(async () => {
      stalePtyId = 'terminal-new'
      return reattach.promise
    })
    transportFactoryQueue.push(staleTransport)
    const pane = createPane(1)
    const manager = createManager(1)
    const paneTransportsRef = { current: new Map<number, MockTransport>() }
    const deps = createDeps({
      paneTransportsRef,
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'terminal-old' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(4)
    expect(staleTransport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'terminal-old' })
    )

    const currentTransport = createMockTransport('terminal-current')
    paneTransportsRef.current.set(pane.id, currentTransport)
    pane.container.dataset.ptyId = 'terminal-current'
    reattach.resolve({ id: 'terminal-new', isReattach: true })
    await flushAsyncTicks(12)

    expect(pane.container.dataset.ptyId).toBe('terminal-current')
    expect(deps.updateTabPtyId).not.toHaveBeenCalled()
    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, 'terminal-new')
  })

  it('accepts an explicit reattach id before the transport publishes its id', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<{ id: string; isReattach: true }>()
    const transport = createMockTransport()
    let transportPtyId: string | null = null
    transport.getPtyId.mockImplementation(() => transportPtyId)
    transport.connect.mockImplementation(async () => reattach.promise)
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'terminal-old' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(4)
    reattach.resolve({ id: 'terminal-new', isReattach: true })
    await flushAsyncTicks(12)

    expect(pane.container.dataset.ptyId).toBe('terminal-new')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'terminal-new', 'terminal-old')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'terminal-new')
  })

  it('does not replace a split sibling with the tab-level source PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    // The source pane is still mounted while the parked tab's new split leaf
    // is hydrated. The daemon may report the split spawn as a reattach even
    // though this pane has no stale session id of its own.
    const sourceTransport = createMockTransport('tab-pty')
    const splitTransport = createMockTransport('split-pty')
    splitTransport.connect.mockResolvedValue({ id: 'split-pty', isReattach: true })
    const paneTransportsRef = {
      current: new Map<number, MockTransport>([[1, sourceTransport]])
    }
    transportFactoryQueue.push(splitTransport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] },
      ptyIdsByTabId: { 'tab-1': ['tab-pty'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF_1 },
            second: { type: 'leaf', leafId: LEAF_2 }
          },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          // The split leaf is intentionally unbound until its connect settles.
          ptyIdsByLeafId: { [LEAF_1]: 'tab-pty' }
        }
      }
    } as StoreState
    const deps = createDeps({ paneTransportsRef })

    connectPanePty(createPane(2) as never, createManager(2) as never, deps as never)
    await flushAsyncTicks(20)

    expect(splitTransport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'split-pty')
    expect(deps.updateTabPtyId).not.toHaveBeenCalledWith('tab-1', 'split-pty', 'tab-pty')
    expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
      [LEAF_1]: 'tab-pty',
      [LEAF_2]: 'split-pty'
    })
  })

  it('infers a replacement when the tab PTY is bound to this leaf', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const splitTransport = createMockTransport('replacement-pty')
    splitTransport.connect.mockResolvedValue({ id: 'replacement-pty', isReattach: true })
    transportFactoryQueue.push(splitTransport)
    // Keep this pane on the fresh-spawn path while retaining a tab-level
    // identity that is also bound to its leaf.
    const paneTransportsRef = {
      current: new Map<number, MockTransport>([[1, createMockTransport()]])
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'terminal-old' }] },
      ptyIdsByTabId: { 'tab-1': ['terminal-old'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: 'terminal-old' }
        }
      }
    } as StoreState
    const deps = createDeps({ paneTransportsRef })

    connectPanePty(createPane(2) as never, createManager(2) as never, deps as never)
    await flushAsyncTicks(20)

    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'replacement-pty', 'terminal-old')
    expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
      [LEAF_2]: 'replacement-pty'
    })
  })

  it.each([
    ['session-expired', { id: 'terminal-new', isReattach: true, sessionExpired: true }],
    ['no-pty', undefined]
  ] as const)(
    'does not let a stale pane transport clear ownership on %s',
    async (_label, result) => {
      const { connectPanePty } = await import('./pty-connection')
      const reattach = createDeferred<
        { id: string; isReattach: true; sessionExpired?: boolean } | undefined
      >()
      const staleTransport = createMockTransport()
      let stalePtyId: string | null = 'terminal-old'
      staleTransport.getPtyId.mockImplementation(() => stalePtyId)
      staleTransport.connect.mockImplementation(async () => {
        stalePtyId = 'terminal-new'
        return reattach.promise
      })
      transportFactoryQueue.push(staleTransport)
      const pane = createPane(1)
      const paneTransportsRef = { current: new Map<number, MockTransport>() }
      const deps = createDeps({
        paneTransportsRef,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'terminal-old' }
      })

      connectPanePty(pane as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(4)
      const currentTransport = createMockTransport('terminal-current')
      paneTransportsRef.current.set(pane.id, currentTransport)
      pane.container.dataset.ptyId = 'terminal-current'
      if (result === undefined) {
        stalePtyId = null
      }
      reattach.resolve(result)
      await flushAsyncTicks(12)

      expect(pane.container.dataset.ptyId).toBe('terminal-current')
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, null)
      expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, 'terminal-new')
    }
  )

  it('adopts a live eager PTY and withholds snapshots after its renderer dies', async () => {
    // Why: a live eager buffer means "attach + replay", not "reattach" — else first mount mis-routes to daemon-reattach and orphans the eager agent PTY.
    const eagerPtyId = 'auto-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === eagerPtyId ? { flush: () => '', dispose: () => {} } : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: eagerPtyId }] },
      ptyIdsByTabId: { 'tab-1': [eagerPtyId] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: eagerPtyId }
        }
      }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: eagerPtyId }
    })

    const pane = createPane(1)
    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: eagerPtyId })
    )
    expect(pane.container.dataset.ptyId).toBe(eagerPtyId)
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: eagerPtyId })
    )
    const { hasPtySerializer } = await import('./pty-buffer-serializer')
    expect(hasPtySerializer(eagerPtyId)).toBe(true)

    const serializeRequestHandler = (
      window.api.pty.onSerializeBufferRequest as unknown as {
        mock: { calls: [[(request: { requestId: string; ptyId: string }) => void]] }
      }
    ).mock.calls[0]?.[0]
    const { notifyUndeliverableWrite } =
      await import('@/lib/pane-manager/terminal-write-pipeline-health')
    notifyUndeliverableWrite(pane.terminal, 'replay-wedged')
    serializeRequestHandler?.({ requestId: 'dead-renderer', ptyId: eagerPtyId })
    await flushAsyncTicks()

    expect(window.api.pty.sendSerializedBuffer).toHaveBeenCalledWith('dead-renderer', null)
  })

  it('does not adopt another tab live eager PTY from a stale restored leaf binding', async () => {
    // Why: restored leaf bindings can outlive tab ownership; a global eager buffer proves the PTY is alive, ptyIdsByTabId proves this tab owns it.
    const otherTabPtyId = 'other-tab-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === otherTabPtyId ? { flush: () => '', dispose: () => {} } : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        return { id: opts.sessionId }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [
          { id: 'tab-1', ptyId: 'tab-pty' },
          { id: 'tab-2', ptyId: otherTabPtyId }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['tab-pty'],
        'tab-2': [otherTabPtyId]
      }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: otherTabPtyId }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.attach).not.toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: otherTabPtyId })
    )
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: otherTabPtyId })
    )
    expect(deps.updateTabPtyId).not.toHaveBeenCalledWith('tab-1', otherTabPtyId)
  })

  it('fresh-spawns a shell into any PTY-less tab, so agent launches must never publish one', async () => {
    // Why: #2989 depends on PTY-less tabs taking this legitimate fresh-shell path.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        return { id: opts.sessionId }
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('stray-shell-pty')
      return 'stray-shell-pty'
    })
    transportFactoryQueue.push(transport)
    // Reproduce the pre-fix gap between createTab and PTY binding.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null
        }
      },
      agentLaunchConfigByPaneKey: {
        [`tab-1:${LEAF_1}`]: {
          launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
          identity: { agentType: 'claude' }
        }
      }
    } as StoreState
    const deps = createDeps()

    const pane = createPane(1)
    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    // Launch registration alone cannot identify a PTY to attach.
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ url: '', cols: expect.any(Number) })
    )
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'stray-shell-pty')
  })

  it('spawns a fresh PTY when a restored daemon split session cannot reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        return undefined
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('fresh-pty')
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'stale-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.connect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'stale-pty' })
    )
    expect(transport.connect).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'stale-pty')
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'stale-pty')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-pty')
  })

  it.each([
    ['rejects', 'reject'],
    ['returns no PTY', 'empty']
  ] as const)(
    'preserves a direct SSH binding and schedules another retry when reattach %s',
    async (_description, outcome) => {
      const { connectPanePty } = await import('./pty-connection')
      const restoredPtyId = 'ssh:conn-1@@restored-session'
      const transport = createMockTransport()
      if (outcome === 'reject') {
        transport.connect.mockRejectedValueOnce(new Error('relay attach timed out'))
      } else {
        transport.connect.mockResolvedValueOnce(undefined)
      }
      transportFactoryQueue.push(transport)
      const pendingRetry = {
        attemptId: 'attempt-generic-reattach-failure',
        authority: {
          targetId: 'conn-1',
          providerEpoch: 'epoch-1',
          connectionGeneration: 3
        },
        tabGeneration: 7,
        startedAt: 1
      }
      const settleDirectSshPaneRetry = vi.fn()
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }]
        },
        ptyIdsByTabId: { 'tab-1': [] },
        repos: [{ id: 'repo1', connectionId: 'conn-1' }],
        sshConnectionStates: new Map([
          [
            'conn-1',
            {
              targetId: 'conn-1',
              status: 'connected',
              providerEpoch: 'epoch-1',
              connectionGeneration: 3
            }
          ]
        ]),
        deferredSshSessionIdsByTabId: { 'tab-1': restoredPtyId },
        directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
        settleDirectSshPaneRetry
      } as StoreState
      const deps = createDeps()

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(12)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(deps.updateTabPtyId).not.toHaveBeenCalled()
      expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
      expect(settleDirectSshPaneRetry).toHaveBeenCalledExactlyOnceWith({
        status: 'failed',
        tabId: 'tab-1',
        attemptId: pendingRetry.attemptId,
        authority: pendingRetry.authority,
        tabGeneration: pendingRetry.tabGeneration
      })
      expect(mockStoreState.tabsByWorktree['wt-1']).toEqual([
        { id: 'tab-1', ptyId: null, generation: 7 }
      ])
      expect(mockStoreState.deferredSshSessionIdsByTabId['tab-1']).toBe(restoredPtyId)
    }
  )

  it('reattaches via the tab-level SSH pty id when deferred bookkeeping missed the tab', async () => {
    // Why: restore can miss the deferred maps; the tab's SSH pty id must still drive connect-then-reattach, not a fresh spawn into a missing provider.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'ssh:conn-1@@pty-7' }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map()
    } as StoreState
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(12)

    const windowApi = (globalThis as unknown as { window: { api: { ssh: { connect: unknown } } } })
      .window.api
    expect(windowApi.ssh.connect).toHaveBeenCalledWith({ targetId: 'conn-1' })
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ssh:conn-1@@pty-7' })
    )
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('connects a disconnected SSH target before fresh-spawning instead of erroring', async () => {
    // Why: spawning against a disconnected target throws "No PTY provider" and strands the pane behind a toast that never retries.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-ssh-pty')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map()
    } as StoreState
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    // Why: no spawn may fire before the SSH connection is established.
    expect(transport.connect).not.toHaveBeenCalled()
    await flushAsyncTicks(12)

    const windowApi = (globalThis as unknown as { window: { api: { ssh: { connect: unknown } } } })
      .window.api
    expect(windowApi.ssh.connect).toHaveBeenCalledWith({ targetId: 'conn-1' })
    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('spawns a fresh PTY when a non-deferred SSH reattach reports expired via onError', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      async (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
          return undefined
        }
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.('fresh-ssh-pty')
        return 'fresh-ssh-pty'
      }
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'restored-session')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-ssh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-ssh-pty')
  })
})
