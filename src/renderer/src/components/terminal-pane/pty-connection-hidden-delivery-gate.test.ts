import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_AFTER_BYTE_GAP } from '../../../../shared/terminal-mode-reset-profiles'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
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

  describe('hidden-delivery gate', () => {
    function enableMainAuthority(): void {
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalMainSideEffectAuthority: true
      } as StoreState['settings']
    }

    function getSetHiddenRendererPtyMock(): ReturnType<typeof vi.fn> {
      return window.api.pty.setHiddenRendererPty as unknown as ReturnType<typeof vi.fn>
    }

    async function connectHiddenPane(deps: ReturnType<typeof createDeps>): Promise<{
      transport: MockTransport
      pane: ReturnType<typeof createPane>
      dataCallback: (
        data: string,
        meta?: { seq?: number; rawLength?: number; droppedOutput?: boolean }
      ) => void
      binding: { syncProcessTracking: () => void; dispose: () => void }
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current:
          | ((
              data: string,
              meta?: { seq?: number; rawLength?: number; droppedOutput?: boolean }
            ) => void)
          | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(pane as never, manager as never, deps as never) as {
        syncProcessTracking: () => void
        dispose: () => void
      }
      await flushAsyncTicks(6)
      expect(capturedDataCallback.current).not.toBeNull()
      return { transport, pane, dataCallback: capturedDataCallback.current!, binding }
    }

    // STA-4042 root: the restore-needed marker is the ONE point where "bytes
    // were dropped" is known. The emulator carries state across chunks just like
    // the cross-chunk parser the handler already resets, so the gap is closed
    // here rather than left to each recovery path to remember.
    it('closes the emulator state gap when a drop is announced', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, dataCallback } = await connectHiddenPane(deps)
      dataCallback('hidden output\r\n', { seq: 16, rawLength: 16 })
      pane.terminal.write.mockClear()

      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })
      await flushAsyncTicks(4)

      const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
      const gapReset = written.find((data) => data === RESET_AFTER_BYTE_GAP)
      expect(gapReset).toBeDefined()
    })

    it('marks the PTY hidden on hidden output and clears it before requesting restore on reveal', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, dataCallback } = await connectHiddenPane(deps)
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'model snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })
      pane.terminal.options.scrollback = 50_000

      dataCallback('hidden output\r\n', { seq: 16, rawLength: 16 })
      expect(setHiddenRendererPty).toHaveBeenCalledWith('pty-id', true)

      // Why: with the skip grammar gone, gated drops latch the restore via main's out-of-band marker, not a renderer content scan.
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })

      // Reveal rides the visible-resume backlog recovery hook.
      ;(deps.isVisibleRef as { current: boolean }).current = true
      const { requestTerminalBacklogRecovery } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      requestTerminalBacklogRecovery(pane.terminal as never)
      await flushAsyncTicks(20)

      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', false)
      expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 50_000 })
      // The unhide IPC must precede the snapshot request (seq-guard contract).
      const unhideOrder = setHiddenRendererPty.mock.invocationCallOrder.at(-1)!
      const snapshotOrder = getMainBufferSnapshot.mock.invocationCallOrder[0]!
      expect(unhideOrder).toBeLessThan(snapshotOrder)
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('model snapshot'),
        expect.any(Function)
      )
    })

    it('holds post-snapshot live bytes until a hidden restore can fit the destination grid', async () => {
      enableMainAuthority()
      const { safeFit } = await import('@/lib/pane-manager/pane-tree-ops')
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, transport, dataCallback } = await connectHiddenPane(deps)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'source-grid hidden snapshot\r\n',
        cols: 80,
        rows: 24,
        seq: 64
      })
      pane.fitAddon.proposeDimensions = vi.fn(() => undefined) as never
      transport.resize.mockClear()

      dataCallback('hidden output\r\n', { seq: 16, rawLength: 16 })
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      const { requestTerminalBacklogRecovery } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      requestTerminalBacklogRecovery(pane.terminal as never)
      await flushAsyncTicks(20)

      expect(transport.resize).not.toHaveBeenCalled()
      dataCallback('live-after-hidden', { seq: 81, rawLength: 17 })
      await flushAsyncTicks(6)
      expect(pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')).not.toContain(
        'live-after-hidden'
      )

      pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 })) as never
      safeFit(pane as never)
      await flushAsyncTicks(20)

      expect(transport.resize).toHaveBeenCalledWith(120, 40)
      expect(pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')).toContain(
        'live-after-hidden'
      )
    })

    it('kicks pane recovery when reveal finds the write pipeline certified dead', async () => {
      // 2026-07-13 fossil-pane incident: bytes drop while hidden, pipeline certified dead, cert recovery empty — reveal must re-kick it.
      enableMainAuthority()
      const remountTerminalTabForRecovery = vi.fn<(tabId: string) => boolean>(() => true)
      mockStoreState = { ...mockStoreState, remountTerminalTabForRecovery } as StoreState
      const { _resetTerminalPaneRecoveryForTests } = await import('./terminal-pane-recovery')
      _resetTerminalPaneRecoveryForTests()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, dataCallback } = await connectHiddenPane(deps)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'model snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })

      dataCallback('hidden output\r\n', { seq: 16, rawLength: 16 })

      // Pipeline dies while hidden; certification-time recovery finds no remountable tab (budget unconsumed, no retry timer).
      remountTerminalTabForRecovery.mockReturnValueOnce(false)
      const ackCredit = vi.fn()
      const { writeTerminalOutput } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      writeTerminalOutput(pane.terminal, 'queued before certification', {
        foreground: false,
        ackCredit
      })
      const { notifyUndeliverableWrite } =
        await import('@/lib/pane-manager/terminal-write-pipeline-health')
      notifyUndeliverableWrite(pane.terminal, 'write-stalled')
      expect(ackCredit).toHaveBeenCalledTimes(1)
      await flushAsyncTicks(4)
      expect(remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      const { requestTerminalBacklogRecovery } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      requestTerminalBacklogRecovery(pane.terminal as never)
      await flushAsyncTicks(20)

      // Restore stays skipped (a dead pipeline can't parse the snapshot), but recovery got exactly one re-kick.
      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      expect(remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
      expect(remountTerminalTabForRecovery).toHaveBeenLastCalledWith('tab-1')

      // Latched per xterm instance: repeat restore attempts do not spam.
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 96 })
      await flushAsyncTicks(4)
      expect(remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
      _resetTerminalPaneRecoveryForTests()
    })

    it('clears the hidden bit on visibility flips through syncProcessTracking', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { dataCallback, binding } = await connectHiddenPane(deps)
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()

      dataCallback('hidden output\r\n')
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', true)
      ;(deps.isVisibleRef as { current: boolean }).current = true
      binding.syncProcessTracking()
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', false)

      // Hiding again re-marks through the same lifecycle hook.
      ;(deps.isVisibleRef as { current: boolean }).current = false
      binding.syncProcessTracking()
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', true)
    })

    it('marks hidden codex panes immediately — no startup renderer-query window remains', async () => {
      enableMainAuthority()
      const deps = createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      })
      const { transport, dataCallback } = await connectHiddenPane(deps)
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const factsHandler = await import('./terminal-side-effect-facts-handler')

      // Why: Phase 6 deleted the 10s codex window — codex startups gate like any hidden pane; main answers their startup probes.
      dataCallback('startup probe output\r\n')
      expect(setHiddenRendererPty).toHaveBeenCalledWith('pty-id', true)

      // The fact records the subscription for gate-managed PTYs; it never answers it (#9993).
      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 8,
        facts: [{ kind: '2031-subscribe' }]
      })
      expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
    })

    it('latches model restore from the out-of-band marker and restores on reveal', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, dataCallback } = await connectHiddenPane(deps)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'dropped bytes snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })
      // Why: the marker subscription is keyed by the live PTY id — the byte path latches it on the first hidden chunk.
      dataCallback('pre-drop output\r\n', { seq: 16, rawLength: 17 })
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')

      // Main dropped gated bytes and signalled it out-of-band.
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })
      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      ;(deps.isVisibleRef as { current: boolean }).current = true
      const { requestTerminalBacklogRecovery } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      requestTerminalBacklogRecovery(pane.terminal as never)
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('dropped bytes snapshot'),
        expect.any(Function)
      )
    })

    it('never answers a 2031-subscribe fact, hidden or visible', async () => {
      // Regression pin (#9993): a subscribe arms future notifications, it is not a query.
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { transport } = await connectHiddenPane(deps)
      // Simulate spawn completion so the pane registers its fact consumer (mock transport never calls onPtySpawn).
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const factsHandler = await import('./terminal-side-effect-facts-handler')

      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 12,
        facts: [{ kind: '2031-subscribe' }]
      })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 24,
        facts: [{ kind: '2031-subscribe' }]
      })

      expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
      expect(transport.sendInputImmediate).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
    })

    it('registers the fact-observed 2031 subscription for later theme flips', async () => {
      enableMainAuthority()
      const recordPaneMode2031Subscription = vi.fn()
      const deps = createDeps({
        isVisibleRef: { current: false },
        recordPaneMode2031Subscription
      })
      const { transport } = await connectHiddenPane(deps)
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const factsHandler = await import('./terminal-side-effect-facts-handler')

      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 12,
        facts: [{ kind: '2031-subscribe' }]
      })

      // Why: without the registry write, maybePushMode2031Flip won't push CSI 997 after a theme change, so the TUI keeps a stale theme.
      expect(recordPaneMode2031Subscription).toHaveBeenCalledWith(1, 'dark')
      expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
    })

    it('retires the fact-registered subscription when the TUI withdraws it', async () => {
      // The counterpart to the test above. A gated pane never sees the withdrawal bytes
      // (main drops them) and the chunk scanner is disabled for it, so this fact is the only
      // observer that can retire the subscription. Left registered, the next theme flip
      // pushes CSI 997 at the shell that replaced the TUI.
      enableMainAuthority()
      const paneMode2031Ref = { current: new Map<number, boolean>() }
      const paneLastThemeModeRef = { current: new Map<number, 'dark' | 'light'>() }
      const deps = createDeps({
        isVisibleRef: { current: false },
        paneMode2031Ref,
        paneLastThemeModeRef,
        // Exactly what use-terminal-pane-lifecycle wires up for this callback.
        recordPaneMode2031Subscription: (paneId: number, subscribedMode: 'dark' | 'light') => {
          paneMode2031Ref.current.set(paneId, true)
          paneLastThemeModeRef.current.set(paneId, subscribedMode)
        }
      })
      await connectHiddenPane(deps)
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const factsHandler = await import('./terminal-side-effect-facts-handler')
      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 12,
        facts: [{ kind: '2031-subscribe' }]
      })
      expect(paneMode2031Ref.current.get(1)).toBe(true)

      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 24,
        facts: [{ kind: '2031-unsubscribe' }]
      })

      expect(paneMode2031Ref.current.get(1)).toBeUndefined()
      expect(paneLastThemeModeRef.current.get(1)).toBeUndefined()
    })

    it('leaves the chunk scanner silent on a gate-managed PTY', async () => {
      // Main's '2031-subscribe' fact already records these; nothing on this path replies.
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { transport, dataCallback } = await connectHiddenPane(deps)
      const before = transport.sendInput.mock.calls.length

      dataCallback('\x1b[?2031h')

      const replies = transport.sendInput.mock.calls
        .slice(before)
        .flat()
        .filter((arg) => String(arg).includes('997'))
      expect(replies).toEqual([])
    })

    it('declares hidden-at-spawn on connect for hidden panes', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { transport } = await connectHiddenPane(deps)
      // Why: mark the PTY hidden before its first byte, closing the spawn-time DA1-loss window where neither side replied.
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ initiallyHidden: true })
      )
    })

    it('keeps visible spawns undeclared (visible spawn unchanged)', async () => {
      enableMainAuthority()
      const deps = createDeps()
      const { transport } = await connectHiddenPane(deps)
      expect(transport.connect.mock.calls[0]![0]).not.toHaveProperty('initiallyHidden')
    })

    it('declares hidden-at-spawn for hidden codex panes too', async () => {
      enableMainAuthority()
      const deps = createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      })
      const { transport } = await connectHiddenPane(deps)
      // Why: the 10s codex startup window is gone — codex spawns are main-owned from byte zero (main pin: pty.test.ts DA1-from-model).
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ initiallyHidden: true })
      )
    })

    it('does not gate or fact-reply when the hidden-delivery kill switch is off', async () => {
      enableMainAuthority()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalHiddenDeliveryGate: false
      } as StoreState['settings']
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { transport, dataCallback } = await connectHiddenPane(deps)
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()

      dataCallback('hidden output\r\n')
      expect(setHiddenRendererPty).not.toHaveBeenCalled()

      // Why: gate off keeps the byte-scan responder authoritative — the fact must not produce a second reply.
      const factsHandler = await import('./terminal-side-effect-facts-handler')
      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 12,
        facts: [{ kind: '2031-subscribe' }]
      })
      expect(transport.sendInput).not.toHaveBeenCalled()
    })

    it('clears a marked-hidden PTY on dispose so a remount is never gated', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { dataCallback, binding } = await connectHiddenPane(deps)
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()

      dataCallback('hidden output\r\n')
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', true)

      binding.dispose()
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', false)
    })

    it('never treats a live chunk that strips to empty as a restore marker', async () => {
      // Why: an all-OSC-9999 chunk arrives as '' after stripping; only pty:modelRestoreNeeded may trigger a restore, not the empty byte path.
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: true } })
      const { dataCallback } = await connectHiddenPane(deps)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >

      dataCallback('', { seq: 32, rawLength: 24 })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    })

    it('gates marker re-arms during an in-flight foreground restore and repaints once after', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: true } })
      await connectHiddenPane(deps)
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      const firstSnapshot = createDeferred<{
        data: string
        cols: number
        rows: number
        seq: number
      }>()
      getMainBufferSnapshot
        .mockReturnValueOnce(firstSnapshot.promise)
        .mockResolvedValue({ data: 'post-flood repaint\r\n', cols: 100, rows: 30, seq: 96 })
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')

      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'pending-cap', markerSeq: 64 })
      await flushAsyncTicks(4)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

      try {
        // Why (rc.7.perf): a second drop marker while the first snapshot serializes is self-backpressure; must NOT re-fetch.
        vi.useFakeTimers()
        _dispatchPtyModelRestoreNeededForTest({
          id: 'pty-id',
          reason: 'pending-cap',
          markerSeq: 80
        })
        firstSnapshot.resolve({ data: 'first snapshot\r\n', cols: 100, rows: 30, seq: 64 })
        await flushAsyncTicks(20)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

        // Flood quiet: suppression window elapses and exactly ONE deferred repaint heals the dropped gap.
        vi.advanceTimersByTime(2_100)
        await flushAsyncTicks(20)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
