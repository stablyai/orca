import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { createRect, createMeasuredElement } from './pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleImagePasteWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleImagePasteWebglAtlasRecovery: vi.fn(),
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
  scheduleImagePasteWebglAtlasRecovery
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

  it('clears the mobile-fit pane binding when the pane connection is disposed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getFitOverrideForPane, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)

    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.('pty-fit')
    setFitOverride('pty-fit', 'mobile-fit', 49, 20)

    expect(getFitOverrideForPane(1, 'tab-1')).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
    expect(pane.container.dataset.ptyId).toBe('pty-fit')

    binding.dispose()

    expect(getFitOverrideForPane(1, 'tab-1')).toBeNull()
    expect(pane.container.dataset.ptyId).toBeUndefined()
  })

  it('refits immediately when binding to a PTY with an active mobile-fit override', async () => {
    const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    Object.defineProperty(pane.container, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          width: 800,
          height: 400,
          top: 0,
          left: 0,
          right: 800,
          bottom: 400
        }) as DOMRect
    })
    ;(
      pane.fitAddon as unknown as { proposeDimensions: () => { cols: number; rows: number } }
    ).proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }))
    pane.terminal.resize.mockImplementation((cols: number, rows: number) => {
      pane.terminal.cols = cols
      pane.terminal.rows = rows
    })
    setFitOverride('pty-fit', 'mobile-fit', 49, 20)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.('pty-fit')

    expect(pane.terminal.resize).toHaveBeenCalledWith(49, 20)
    expect(pane.terminal.cols).toBe(49)
    expect(pane.terminal.rows).toBe(20)
  })

  it('continues post-spawn size reconcile after a transient mobile presence lock', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const runNextFrame = (): void => {
      const callback = frameCallbacks.shift()
      if (!callback) {
        throw new Error('expected a queued animation frame')
      }
      callback(0)
    }

    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    const ptyId = 'pty-post-spawn-transient-lock'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }
      const pane = createPane(1)
      pane.terminal.cols = 80
      pane.terminal.rows = 24

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      runNextFrame()
      await flushAsyncTicks()

      pane.terminal.cols = 120
      pane.terminal.rows = 40
      runNextFrame()
      expect(transport.resize).not.toHaveBeenCalled()

      setDriverForPty(ptyId, { kind: 'idle' })
      runNextFrame()

      expect(transport.resize).toHaveBeenCalledWith(120, 40)
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('waits for setup-split geometry before spawning the initial startup command', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const runNextFrame = (): void => {
      const callback = frameCallbacks.shift()
      if (!callback) {
        throw new Error('expected a queued animation frame')
      }
      callback(0)
    }

    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }

    const pane = createPane(1)
    const siblingPane = createPane(2)
    let panes = [pane]
    let proposedGrid = { cols: 240, rows: 50 }
    let splitMounted = false
    const root = createMeasuredElement({ rect: () => createRect(1200, 800) })
    const split = createMeasuredElement({
      className: () => (splitMounted ? 'pane-split is-vertical' : ''),
      rect: () => createRect(1200, 800)
    })
    const mainContainer = createMeasuredElement({
      parentElement: () => (splitMounted ? split : root),
      rect: () => (splitMounted ? createRect(600, 800) : createRect(1200, 800))
    })
    const setupContainer = createMeasuredElement({
      parentElement: () => (splitMounted ? split : null),
      rect: () => createRect(599, 800, 601, 0)
    })
    pane.container = mainContainer
    siblingPane.container = setupContainer
    ;(
      pane.fitAddon as unknown as {
        proposeDimensions: () => { cols: number; rows: number }
      }
    ).proposeDimensions = vi.fn(() => proposedGrid)
    pane.fitAddon.fit = vi.fn(() => {
      pane.terminal.cols = proposedGrid.cols
      pane.terminal.rows = proposedGrid.rows
    })

    const manager = createManager(1)
    manager.getPanes = vi.fn(() => panes)
    connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        startup: { command: 'codex', waitForSetupSplitDirection: 'vertical' }
      }) as never
    )

    runNextFrame()
    for (let i = 0; i < 8; i++) {
      runNextFrame()
    }
    expect(transport.connect).not.toHaveBeenCalled()

    splitMounted = true
    panes = [pane, siblingPane]
    proposedGrid = { cols: 120, rows: 50 }
    let postSplitFrames = 0
    while (frameCallbacks.length > 0 && transport.connect.mock.calls.length === 0) {
      if (postSplitFrames >= 12) {
        throw new Error('startup did not connect after setup split became ready')
      }
      postSplitFrames += 1
      runNextFrame()
    }

    expect(createdTransportOptions[0]?.command).toBe('codex')
    expect(transport.connect).toHaveBeenCalledWith(expect.objectContaining({ cols: 120, rows: 50 }))
  })

  it('spawns the delayed main setup-split pane when its sibling owns the tab PTY fallback', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const runNextFrame = (): void => {
      const callback = frameCallbacks.shift()
      if (!callback) {
        throw new Error('expected a queued animation frame')
      }
      callback(0)
    }

    const { connectPanePty } = await import('./pty-connection')
    let mainPtyId: string | null = null
    const mainTransport = createMockTransport()
    mainTransport.getPtyId.mockImplementation(() => mainPtyId)
    mainTransport.attach.mockImplementation(({ existingPtyId }: { existingPtyId: string }) => {
      mainPtyId = existingPtyId
    })
    mainTransport.connect.mockImplementation(async () => {
      mainPtyId = 'pty-main'
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.(mainPtyId)
      return mainPtyId
    })
    let setupPtyId: string | null = null
    const setupTransport = createMockTransport()
    setupTransport.getPtyId.mockImplementation(() => setupPtyId)
    setupTransport.connect.mockImplementation(async () => {
      setupPtyId = 'pty-setup'
      const onPtySpawn = createdTransportOptions[1]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.(setupPtyId)
      return setupPtyId
    })
    transportFactoryQueue.push(mainTransport, setupTransport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }
    const updateStoreTabPtyId = vi.fn((_tabId: string, ptyId: string) => {
      mockStoreState.tabsByWorktree['wt-1'][0].ptyId = ptyId
      const livePtyIds = mockStoreState.ptyIdsByTabId?.['tab-1'] ?? []
      if (!livePtyIds.includes(ptyId)) {
        livePtyIds.push(ptyId)
      }
    })

    const mainPane = createPane(1)
    const setupPane = createPane(2)
    let splitMounted = false
    const root = createMeasuredElement({ rect: () => createRect(1200, 800) })
    const split = createMeasuredElement({
      className: () => (splitMounted ? 'pane-split is-vertical' : ''),
      rect: () => createRect(1200, 800)
    })
    const mainContainer = createMeasuredElement({
      parentElement: () => (splitMounted ? split : root),
      rect: () => (splitMounted ? createRect(600, 800) : createRect(1200, 800))
    })
    const setupContainer = createMeasuredElement({
      parentElement: () => split,
      rect: () => createRect(599, 800, 601, 0)
    })
    mainPane.container = mainContainer
    setupPane.container = setupContainer
    const manager = createManager(2)
    manager.getPanes = vi.fn(() => [mainPane, setupPane])
    const sharedTransportsRef = { current: new Map() }

    connectPanePty(
      mainPane as never,
      manager as never,
      createDeps({
        startup: { command: 'codex', waitForSetupSplitDirection: 'vertical' },
        paneTransportsRef: sharedTransportsRef,
        updateTabPtyId: updateStoreTabPtyId
      }) as never
    )
    connectPanePty(
      setupPane as never,
      manager as never,
      createDeps({
        startup: { command: 'bash setup-runner.sh' },
        paneTransportsRef: sharedTransportsRef,
        updateTabPtyId: updateStoreTabPtyId
      }) as never
    )

    for (let frame = 0; frame < 40 && setupTransport.connect.mock.calls.length === 0; frame++) {
      runNextFrame()
    }
    expect(setupTransport.connect).toHaveBeenCalledTimes(1)
    expect(mockStoreState.tabsByWorktree['wt-1'][0].ptyId).toBe('pty-setup')
    expect(mainTransport.connect).not.toHaveBeenCalled()

    splitMounted = true
    for (
      let frame = 0;
      frame < 20 &&
      mainTransport.connect.mock.calls.length === 0 &&
      mainTransport.attach.mock.calls.length === 0;
      frame++
    ) {
      runNextFrame()
    }

    expect(mainTransport.attach).not.toHaveBeenCalled()
    expect(mainTransport.connect).toHaveBeenCalledTimes(1)
    expect(mainTransport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(createdTransportOptions[0]?.command).toBe('codex')
    expect(createdTransportOptions[1]?.command).toBe('bash setup-runner.sh')
    expect(mainPtyId).toBe('pty-main')
    expect(setupPtyId).toBe('pty-setup')
  })

  it('does not reuse a sibling split pane pending spawn after remount', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const mainSpawn = createDeferred<string>()
    const setupSpawn = createDeferred<string>()

    const mainTransport = createMockTransport()
    mainTransport.connect.mockImplementation(async () => mainSpawn.promise)
    const setupTransport = createMockTransport()
    setupTransport.connect.mockImplementation(async () => setupSpawn.promise)
    const remountTransport = createMockTransport()
    transportFactoryQueue.push(mainTransport, setupTransport, remountTransport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const sharedTransportsRef = { current: new Map() }
    connectPanePty(
      createPane(1) as never,
      createManager(2) as never,
      createDeps({ paneTransportsRef: sharedTransportsRef }) as never
    )
    connectPanePty(
      createPane(2) as never,
      createManager(2) as never,
      createDeps({
        startup: { command: 'bash setup-runner.sh' },
        paneTransportsRef: sharedTransportsRef
      }) as never
    )

    const remountDeps = createDeps()
    const remountPane = createPane(1)
    connectPanePty(remountPane as never, createManager(2) as never, remountDeps as never)

    setupSpawn.resolve('pty-setup')
    mainSpawn.resolve('pty-main')
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(remountTransport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'pty-main' })
    )
    expect(remountPane.container.dataset.ptyId).toBe('pty-main')
    expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-main')
    expect(remountDeps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-main')
  })

  it('binds a fresh spawn that resolves as a daemon reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    let currentPtyId: string | null = null
    const transport = createMockTransport()
    transport.getPtyId.mockImplementation(() => currentPtyId)
    transport.connect.mockImplementation(async () => {
      currentPtyId = 'pty-daemon-reattach'
      return { id: currentPtyId, isReattach: true }
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }

    const pane = createPane(1)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(pane.container.dataset.ptyId).toBe('pty-daemon-reattach')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-daemon-reattach')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-daemon-reattach')
    // Why: the restored shell keeps the CODEX_HOME it was spawned with, and this
    // bind is the first moment the daemon PTY can be inspected for it.
    expect(notifyCodexPaneBoundForStaleSweep).toHaveBeenCalledWith('pty-daemon-reattach')
  })

  it('replays a stable-pane adoption without submitting the SSH resume command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const stablePtyId = toAppSshPtyId('conn-1', 'stable-pane-session')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }) => {
      callbacks.onReattachDetermined?.()
      transport.getPtyId.mockReturnValue(stablePtyId)
      callbacks.onData?.('NEWER-LIVE-SSH-OUTPUT')
      return {
        id: stablePtyId,
        isReattach: true,
        replay: 'ORIGINAL-LIVE-SSH-OUTPUT'
      }
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    }
    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      startup: { command: 'codex resume provider-session' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(4)
    if (!onDataHandler || parseCallbacks.length === 0) {
      throw new Error('expected replay and terminal input handlers')
    }
    ;(onDataHandler as (data: string) => void)('DURING_ADOPTION_REPLAY\r')
    expect(transport.sendInput).not.toHaveBeenCalledWith('DURING_ADOPTION_REPLAY\r')
    for (let step = 0; step < 30; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }
    ;(onDataHandler as (data: string) => void)('AFTER_ADOPTION_REPLAY\r')

    expect(pane.container.dataset.ptyId).toBe(stablePtyId)
    expect(writes.join('')).toContain('ORIGINAL-LIVE-SSH-OUTPUT')
    expect(writes.join('').indexOf('ORIGINAL-LIVE-SSH-OUTPUT')).toBeLessThan(
      writes.join('').indexOf('NEWER-LIVE-SSH-OUTPUT')
    )
    expect(transport.sendInput).not.toHaveBeenCalledWith('codex resume provider-session\r')
    expect(transport.sendInput).toHaveBeenCalledWith('AFTER_ADOPTION_REPLAY\r')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, stablePtyId)
  })

  it('drops xterm onData while pane is replaying restored bytes', async () => {
    // Regression: during replay, xterm auto-replies to embedded queries (DA1/DECRQM/OSC/CPR) via onData must not reach transport.sendInput or they land as stray chars on the prompt. See replay-guard.ts.
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-live')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const replayingPanesRef = { current: new Map<number, number>([[1, 1]]) }
    const deps = createDeps({ replayingPanesRef })
    const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    // Simulate xterm emitting a DA1 auto-reply during replay parse.
    ;(onDataHandler as (data: string) => void)('\x1b[?1;2c')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.claimViewport).not.toHaveBeenCalled()

    // Once replay completes (guard cleared), real keystrokes flow through.
    replayingPanesRef.current.delete(1)
    setFitOverride('pty-live', 'remote-desktop-fit', 80, 24)
    transport.claimViewport.mockClear()
    ;(onDataHandler as (data: string) => void)('a')
    expect(transport.sendInput).toHaveBeenCalledWith('a')
    expect(transport.claimViewport).toHaveBeenCalledTimes(1)
    ;(onDataHandler as (data: string) => void)('b')
    // The renderer stays parked until runtime convergence is acknowledged, so a second keystroke can retry a transient failed resize.
    expect(transport.claimViewport).toHaveBeenCalledTimes(2)
    setFitOverride('pty-live', 'desktop-fit', 0, 0)
  })
})
