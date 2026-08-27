import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEagerPtyBufferHandle } from './pty-dispatcher'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  LEAF_1,
  LEAF_2,
  captureCallbackTerminalWrites,
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

  it('adopts a live eager PTY and withholds snapshots after its renderer dies', async () => {
    // Why: a live eager buffer means "attach + replay", not "reattach" — else first mount mis-routes to daemon-reattach and orphans the eager agent PTY.
    const eagerPtyId = 'auto-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === eagerPtyId ? { peek: () => '', flush: () => '', dispose: () => {} } : undefined
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

  it('replays an eager background buffer at its capture dims before fitting back to the pane grid', async () => {
    // Why: background agents spawn at a fixed grid and their TUI renders the
    // eager buffer at that size. Replaying those bytes at the pane's fitted
    // grid rewraps rows, so inline TUIs (Cursor CLI) anchor their block cursor
    // below the input box. Adoption must replay at capture dims, then fit back.
    const eagerPtyId = 'auto-eager-pty'
    const eagerFrame = 'Cursor Agent\r\n→ prompt text'
    const flush = vi.fn(() => eagerFrame)
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === eagerPtyId
        ? {
            peek: () => eagerFrame,
            flush,
            dispose: () => {},
            captureDims: { cols: 120, rows: 40 }
          }
        : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    // Why: real LocalPtyTransport.attach flushes the eager buffer into onReplayData;
    // the connection mock must drain the same way or adopt tests never exercise replay.
    transport.attach.mockImplementation(
      ({ existingPtyId, callbacks }: { existingPtyId: string; callbacks?: ConnectCallbacks }) => {
        transport.getPtyId.mockReturnValue(existingPtyId)
        const buffered = getEagerPtyBufferHandle(existingPtyId)?.flush() ?? ''
        if (buffered) {
          callbacks?.onReplayData?.(buffered, { clearBeforeReplay: true })
        }
      }
    )
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
    pane.terminal.cols = 80
    pane.terminal.rows = 24
    pane.terminal.resize = vi.fn((cols: number, rows: number) => {
      pane.terminal.cols = cols
      pane.terminal.rows = rows
    }) as typeof pane.terminal.resize
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 })) as never
    pane.fitAddon.fit = vi.fn(() => {
      pane.terminal.cols = 80
      pane.terminal.rows = 24
    })
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    for (let step = 0; step < 40; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }

    // Why: defer PTY cols/rows until after capture-dim replay finishes.
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: eagerPtyId })
    )
    expect(transport.attach.mock.calls[0]?.[0]).not.toHaveProperty('cols')
    expect(flush).toHaveBeenCalled()
    expect(writes).toContain(eagerFrame)
    expect(pane.terminal.resize).toHaveBeenCalledWith(120, 40)
    const resizeToCaptureCall = pane.terminal.resize.mock.invocationCallOrder.find(
      (_order, index) => {
        const [resizeCols, resizeRows] = pane.terminal.resize.mock.calls[index]
        return resizeCols === 120 && resizeRows === 40
      }
    )
    const attachOrder = transport.attach.mock.invocationCallOrder[0]
    expect(resizeToCaptureCall).toBeDefined()
    expect(resizeToCaptureCall as number).toBeLessThan(attachOrder)
    const fitOrders = vi.mocked(pane.fitAddon.fit).mock.invocationCallOrder
    expect(fitOrders.some((order) => order > attachOrder)).toBe(true)
    expect(transport.resize).toHaveBeenCalledWith(80, 24)
    expect(pane.terminal.cols).toBe(80)
    expect(pane.terminal.rows).toBe(24)
  })

  it('re-parks the real cursor after eager adopt when the buffer ends with ?25l', async () => {
    // Why: Cursor Agent paints its own input caret and hides the real terminal
    // cursor. If adopt/fit leaves DECTCEM shown, a stray block appears under the
    // footer (dual cursor) while the painted caret stays in the input.
    const eagerPtyId = 'auto-eager-pty'
    const parkedAgentFrame = 'Cursor Agent\r\n→ prompt text\x1b[?25l'
    const flush = vi.fn(() => parkedAgentFrame)
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === eagerPtyId
        ? {
            peek: () => parkedAgentFrame,
            flush,
            dispose: () => {},
            captureDims: { cols: 120, rows: 40 }
          }
        : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.attach.mockImplementation(
      ({ existingPtyId, callbacks }: { existingPtyId: string; callbacks?: ConnectCallbacks }) => {
        transport.getPtyId.mockReturnValue(existingPtyId)
        const buffered = getEagerPtyBufferHandle(existingPtyId)?.flush() ?? ''
        if (buffered) {
          callbacks?.onReplayData?.(buffered, { clearBeforeReplay: true })
        }
      }
    )
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
    pane.terminal.cols = 80
    pane.terminal.rows = 24
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 })) as never
    pane.fitAddon.fit = vi.fn(() => {
      pane.terminal.cols = 80
      pane.terminal.rows = 24
    })
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    for (let step = 0; step < 40; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }

    expect(flush).toHaveBeenCalled()
    const frameIndex = writes.indexOf(parkedAgentFrame)
    const hideIndex = writes.indexOf('\x1b[?25l')
    expect(frameIndex).toBeGreaterThanOrEqual(0)
    expect(hideIndex).toBeGreaterThan(frameIndex)
    expect(transport.resize).toHaveBeenCalled()
  })

  it('does not pre-resize when adopting an eager buffer without capture dims', async () => {
    const eagerPtyId = 'auto-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === eagerPtyId ? { peek: () => '', flush: () => '', dispose: () => {} } : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: eagerPtyId }] },
      ptyIdsByTabId: { 'tab-1': [eagerPtyId] }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: eagerPtyId }
    })

    const pane = createPane(1)
    pane.terminal.cols = 80
    pane.terminal.rows = 24

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: eagerPtyId })
    )
    expect(pane.terminal.resize).not.toHaveBeenCalled()
  })

  it('does not adopt another tab live eager PTY from a stale restored leaf binding', async () => {
    // Why: restored leaf bindings can outlive tab ownership; a global eager buffer proves the PTY is alive, ptyIdsByTabId proves this tab owns it.
    const otherTabPtyId = 'other-tab-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === otherTabPtyId ? { peek: () => '', flush: () => '', dispose: () => {} } : undefined
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
