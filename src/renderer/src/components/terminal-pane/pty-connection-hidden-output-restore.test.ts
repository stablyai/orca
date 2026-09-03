import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks, renderHeadlessBuffer } from './pty-connection-test-async'
import {
  LEAF_1,
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

  it('does not apply stale background Codex query chunks after hidden snapshot restore', async () => {
    // Fire-all like a real event target: both the pane resync and stale-visibility trust handlers listen for visibilitychange.
    const visibilityChangeListeners: (() => void)[] = []
    const visibilityChangeHandler = {
      current: (): void => {
        for (const listener of visibilityChangeListeners) {
          listener()
        }
      }
    }
    ;(globalThis as { document?: Document }).document = {
      visibilityState: 'visible',
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') {
          visibilityChangeListeners.push(listener as () => void)
        }
      }),
      removeEventListener: vi.fn()
    } as unknown as Document

    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current:
        | ((
            data: string,
            meta?: { seq?: number; rawLength?: number; background?: boolean }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >

    const hiddenFrame = '\r\x1b[2KWorking hidden'
    const staleQueryFrame = '\r\x1b[2KWorking stale\x1b[6n'
    const currentFrame = '\r\x1b[2KWorking current'
    const staleSeq = hiddenFrame.length + staleQueryFrame.length
    const currentSeq = staleSeq + currentFrame.length
    // The main emulator already parsed every frame, so the snapshot covers the query frame still in flight on the pty:data channel.
    getMainBufferSnapshot.mockResolvedValue({
      data: currentFrame,
      cols: 80,
      rows: 8,
      seq: currentSeq
    })

    const pane = createPane(1)
    pane.terminal.cols = 80
    pane.terminal.rows = 8
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hiddenFrame, {
      seq: hiddenFrame.length,
      rawLength: hiddenFrame.length
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    visibilityChangeHandler.current?.()
    await flushAsyncTicks(20)

    // The in-flight chunks arrive in channel order after the restore already rebuilt the buffer from the newer snapshot.
    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.(staleQueryFrame, {
        seq: staleSeq,
        rawLength: staleQueryFrame.length,
        background: true
      })
      capturedDataCallback.current?.(currentFrame, {
        seq: currentSeq,
        rawLength: currentFrame.length,
        background: true
      })
      vi.advanceTimersByTime(50)
      await flushAsyncTicks(6)
    } finally {
      vi.useRealTimers()
    }

    const rendererBuffer = await renderHeadlessBuffer(writes, 80, 8)
    const referenceBuffer = await renderHeadlessBuffer(
      [hiddenFrame, staleQueryFrame, currentFrame],
      80,
      8
    )

    expect(writes).not.toContain(staleQueryFrame)
    expect(rendererBuffer).toEqual(referenceBuffer)
    binding.dispose()
  })

  it('restores hidden Codex output after a suppressed exit revives the same ptyId with a restarted seq counter', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current:
        | ((
            data: string,
            meta?: { seq?: number; rawLength?: number; background?: boolean }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >

    const hiddenFrame = '\r\x1b[2KWorking hidden'
    const visibleFrame = '\r\x1b[2KWorking now'
    const hiddenSeq = hiddenFrame.length
    const visibleSeq = hiddenSeq + visibleFrame.length
    // Why 3 extra bytes: the main emulator runs ahead of the renderer's received chunks, so the snapshot seq exceeds the channel seq.
    const preExitSnapshotSeq = visibleSeq + 3
    getMainBufferSnapshot.mockResolvedValue({
      data: visibleFrame,
      cols: 80,
      rows: 8,
      seq: preExitSnapshotSeq
    })

    const pane = createPane(1)
    pane.terminal.cols = 80
    pane.terminal.rows = 8
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' },
      consumeSuppressedPtyExit: vi.fn(() => true)
    })
    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hiddenFrame, { seq: hiddenSeq, rawLength: hiddenFrame.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(visibleFrame, {
      seq: visibleSeq,
      rawLength: visibleFrame.length
    })
    await flushAsyncTicks(20)

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    onPtyExit?.('pty-id')

    // Revived session: same ptyId, seq restarted — the revived chunk sits below the pre-exit snapshot seq; only the exit reset stops it being judged covered.
    ;(deps.isVisibleRef as { current: boolean }).current = false
    const revivedHiddenFrame = '\r\x1b[2KWorking revived'
    capturedDataCallback.current?.(revivedHiddenFrame, {
      seq: preExitSnapshotSeq - 1,
      rawLength: revivedHiddenFrame.length
    })

    const revivedSnapshotFrame = '\r\x1b[2KREVIVED SNAPSHOT'
    getMainBufferSnapshot.mockResolvedValue({
      data: revivedSnapshotFrame,
      cols: 80,
      rows: 8,
      seq: preExitSnapshotSeq - 1
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    const revivedVisibleFrame = '\r\x1b[2Kafter revive'
    capturedDataCallback.current?.(revivedVisibleFrame, {
      seq: preExitSnapshotSeq - 1 + revivedVisibleFrame.length,
      rawLength: revivedVisibleFrame.length
    })
    await flushAsyncTicks(20)

    const written = writes.join('')
    expect(written).toContain('REVIVED SNAPSHOT')
    expect(written).toContain('after revive')
    binding.dispose()
  })

  it('restores hidden Codex output when the pty seq counter restarts without an observed exit', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current:
        | ((
            data: string,
            meta?: { seq?: number; rawLength?: number; background?: boolean }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >

    const pane = createPane(1)
    pane.terminal.cols = 80
    pane.terminal.rows = 8
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: true },
      startup: { command: 'codex' }
    })
    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    const establishedFrame = '\r\x1b[2KWorking established'
    capturedDataCallback.current?.(establishedFrame, {
      seq: 50_000,
      rawLength: establishedFrame.length
    })
    await flushAsyncTicks(6)

    // Main lost the pty silently and the seq counter restarted; the channel seq regression must invalidate the old high-water mark, not cover the new stream.
    ;(deps.isVisibleRef as { current: boolean }).current = false
    const revivedHiddenFrame = '\r\x1b[2KWorking revived'
    capturedDataCallback.current?.(revivedHiddenFrame, {
      seq: revivedHiddenFrame.length,
      rawLength: revivedHiddenFrame.length
    })

    const revivedSnapshotFrame = '\r\x1b[2KREVIVED SNAPSHOT2'
    getMainBufferSnapshot.mockResolvedValue({
      data: revivedSnapshotFrame,
      cols: 80,
      rows: 8,
      seq: revivedHiddenFrame.length
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    const revivedVisibleFrame = '\r\x1b[2Kafter revive'
    capturedDataCallback.current?.(revivedVisibleFrame, {
      seq: revivedHiddenFrame.length + revivedVisibleFrame.length,
      rawLength: revivedVisibleFrame.length
    })
    await flushAsyncTicks(20)

    expect(writes.join('')).toContain('REVIVED SNAPSHOT2')
    binding.dispose()
  })

  it('writes ordinary hidden output live instead of proactively restoring a snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'small-hidden-output\r\n'
    const live = 'visible-after-hidden\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: `snapshot-with-${hidden}`,
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(hidden)
    expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('pauses capable paired output while hidden and restores exactly on reveal', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const remotePtyId = 'remote:env-1@@terminal-1'
    const transport = createMockTransport(remotePtyId)
    let callbacks: ConnectCallbacks = {}
    transport.connect.mockImplementation(async (options: { callbacks?: ConnectCallbacks }) => {
      callbacks = options.callbacks ?? {}
      return remotePtyId
    })
    transport.setOutputPaused = vi.fn((paused: boolean) => {
      callbacks.onOutputPauseChanged?.(paused, true)
      return true
    })
    const hidden = 'paired hidden flood\r\n'
    const snapshot = 'paired snapshot with hidden flood\r\n'
    const live = 'paired visible marker\r\n'
    transport.serializeBuffer = vi.fn().mockResolvedValue({
      data: snapshot,
      cols: 100,
      rows: 30,
      seq: hidden.length,
      source: 'headless'
    })
    transportFactoryQueue.push(transport)
    mockStoreState.repos = [
      { id: 'repo1', connectionId: null, displayName: 'orca', executionHostId: 'runtime:env-1' }
    ]
    mockStoreState.worktreesByRepo.repo1[0].runtimeOwnerEnvironmentId = 'env-1'

    const pane = createPane(1)
    const manager = createManager(1)
    const recordPaneMode2031Subscription = vi.fn()
    const deps = createDeps({
      isVisibleRef: { current: false },
      recordPaneMode2031Subscription
    })
    const binding = connectPanePty(pane as never, manager as never, deps as never) as {
      syncProcessTracking: () => void
      dispose: () => void
    }
    await flushAsyncTicks(6)

    expect(transport.setOutputPaused).toHaveBeenLastCalledWith(true)
    expect(
      (transport.sendInput as unknown as (data: string) => boolean)('hidden input marker')
    ).toBe(true)
    expect(transport.sendInput).toHaveBeenCalledWith('hidden input marker')
    callbacks.onData?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    const factsHandler = await import('./terminal-side-effect-facts-handler')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-1', expect.any(Object))
    mockStoreState.ptyIdsByTabId = { 'tab-1': [remotePtyId] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = {
      [LEAF_1]: remotePtyId
    }
    const visibleStatusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'working'; prompt: string; agentType: 'claude' }) => void)
      | undefined
    expect(visibleStatusHandler).toBeTypeOf('function')
    visibleStatusHandler?.({
      state: 'working',
      prompt: 'visible control',
      agentType: 'claude'
    })
    expect(mockStoreState.setAgentStatus).toHaveBeenCalledTimes(1)
    mockStoreState.setAgentStatus.mockClear()
    factsHandler._dispatchTerminalSideEffectBatchForTest({
      ptyId: remotePtyId,
      seq: hidden.length,
      facts: [
        {
          kind: 'agent-status',
          payload: { state: 'working', prompt: 'paired task', agentType: 'claude' }
        },
        { kind: 'title', normalizedTitle: 'remote working', rawTitle: 'remote working' },
        { kind: '2031-subscribe' }
      ]
    })
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'remote working')
    expect(mockStoreState.setAgentStatus).toHaveBeenCalledTimes(1)
    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'paired task',
        agentType: 'claude',
        // Why: the renderer parsed these OSC 9999 bytes itself for a remote-runtime pane, so it
        // is the sequencing authority for the row (STA-4293).
        observation: expect.objectContaining({ origin: 'osc', kind: 'snapshot' })
      },
      undefined,
      undefined,
      { connectionId: null }
    )
    // Remote gated panes record the subscription from the fact and answer nothing (#9993).
    expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
    expect(recordPaneMode2031Subscription).toHaveBeenCalledWith(1, expect.any(String))
    deps.paneMode2031Ref.current.set(1, true)
    deps.paneLastThemeModeRef.current.set(1, 'dark')
    factsHandler._dispatchTerminalSideEffectBatchForTest({
      ptyId: remotePtyId,
      seq: hidden.length + 1,
      facts: [{ kind: '2031-unsubscribe' }]
    })
    expect(deps.paneMode2031Ref.current.has(1)).toBe(false)

    ;(deps.isVisibleRef as { current: boolean }).current = true
    binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(transport.setOutputPaused).toHaveBeenLastCalledWith(false)
    expect(transport.serializeBuffer).toHaveBeenCalledWith({ scrollbackRows: 5000 })
    expect(transport.setOutputPaused.mock.invocationCallOrder.at(-1)).toBeLessThan(
      transport.serializeBuffer.mock.invocationCallOrder[0]
    )
    callbacks.onData?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)
    const written = pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
    const countWritten = (marker: string): number => written.split(marker).length - 1
    expect(countWritten(snapshot)).toBe(1)
    expect(countWritten(live)).toBe(1)
    expect(countWritten(hidden)).toBe(0)

    binding.dispose()
    expect(transport.setOutputPaused).toHaveBeenLastCalledWith(false)
    deps.setRuntimePaneTitle.mockClear()
    factsHandler._dispatchTerminalSideEffectBatchForTest({
      ptyId: remotePtyId,
      seq: hidden.length + live.length + 1,
      facts: [{ kind: 'title', normalizedTitle: 'stale', rawTitle: 'stale' }]
    })
    expect(deps.setRuntimePaneTitle).not.toHaveBeenCalled()
  })

  it('locally gates hidden paired output when a legacy host cannot pause it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const remotePtyId = 'remote:legacy-env@@terminal-1'
    const transport = createMockTransport(remotePtyId)
    let callbacks: ConnectCallbacks = {}
    transport.connect.mockImplementation(async (options: { callbacks?: ConnectCallbacks }) => {
      callbacks = options.callbacks ?? {}
      return remotePtyId
    })
    transport.setOutputPaused = vi.fn((paused: boolean) => {
      callbacks.onOutputPauseChanged?.(paused, false)
      return false
    })
    const hidden = 'legacy hidden flood\r\n'
    const snapshot = 'legacy snapshot with hidden flood\r\n'
    const live = 'legacy visible marker\r\n'
    transport.serializeBuffer = vi.fn().mockResolvedValue({
      data: snapshot,
      cols: 100,
      rows: 30,
      seq: hidden.length,
      source: 'headless'
    })
    transportFactoryQueue.push(transport)
    mockStoreState.repos = [
      {
        id: 'repo1',
        connectionId: null,
        displayName: 'orca',
        executionHostId: 'runtime:legacy-env'
      }
    ]
    mockStoreState.worktreesByRepo.repo1[0].runtimeOwnerEnvironmentId = 'legacy-env'

    const pane = createPane(1)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const binding = connectPanePty(pane as never, createManager(1) as never, deps as never) as {
      syncProcessTracking: () => void
      dispose: () => void
    }
    await flushAsyncTicks(6)

    expect(transport.setOutputPaused).toHaveBeenLastCalledWith(true)
    callbacks.onData?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(transport.setOutputPaused).toHaveBeenLastCalledWith(false)
    expect(transport.serializeBuffer).toHaveBeenCalledWith({ scrollbackRows: 5000 })
    callbacks.onData?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    const written = pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
    expect(written).toContain(snapshot)
    expect(written).toContain(live)
    expect(written).not.toContain(hidden)
    binding.dispose()
  })
})
