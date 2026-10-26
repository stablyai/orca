import type * as React from 'react'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushAsyncTicks,
  createDeferred,
  renderHeadlessBuffer,
  writeHeadlessTerminal
} from './pty-connection-test-async'
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

// The connection fixture invokes hooks without mounting React.
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

// Stub eager-buffer lookup to exercise live adoption without the IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

const { safeFitAndThen } = vi.hoisted(() => ({ safeFitAndThen: vi.fn() }))
vi.mock('@/lib/pane-manager/pane-tree-ops', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFitAndThen
}))

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

describe('connectPanePty', () => {
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
    await restoreTerminalTestGlobals()
  })

  it.each([
    { name: 'overflowed', pending: 'v'.repeat(512 * 1024 + 1), repaint: true, covered: 0 },
    { name: 'small', pending: 'Working\r\n', repaint: false, covered: 0 },
    { name: 'partially covered', pending: 'Working\r\n', repaint: false, covered: 4 },
    { name: 'split escape', pending: '14mWorking\r\n', repaint: false, covered: 0 },
    { name: 'styled', pending: 'Working\r\n', repaint: false, covered: 0 },
    { name: 'styled gap', pending: 'Working\r\n', repaint: true, covered: 0 },
    { name: 'unmapped', pending: 'Working\r\n', repaint: true, covered: 4 },
    { name: 'unhide gap', pending: 'Working\r\n', repaint: true, covered: 0 },
    { name: 'fresh snapshot gap', pending: 'Working\r\n', repaint: true, covered: 0 }
  ])(
    'recovers $name live output when the deadline interrupts an answered snapshot',
    async ({ name, pending, repaint, covered }) => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      let onData: ConnectCallbacks['onData']
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          onData = callbacks.onData
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const fit = createDeferred<boolean>()
      safeFitAndThen.mockReturnValue({ completion: Promise.resolve(true), cancel: vi.fn() })

      const getSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const hidden = 'hidden-before-flood\r\n'
      const pendingEscapeTailAnsi = name === 'split escape' ? '\x1b[38;5;' : ''
      const style = name.startsWith('styled') ? '\x1b[38;5;214m' : ''
      const hiddenData = `${hidden}${style}${pendingEscapeTailAnsi}`
      const firstLive = name === 'split escape' ? '2' : 'v'
      const snapshot =
        covered > 0 ? `${hidden}${firstLive}${pending.slice(0, covered)}` : `${hidden}${style}`
      const snapshotSeq = hiddenData.length + (covered > 0 ? firstLive.length + covered : 0)
      const done = 'HIDDEN_FLOOD_DONE\r\n'
      const rawLength = pending.length + (name === 'unmapped' ? 5 : 0)
      let seq = hiddenData.length + firstLive.length + rawLength
      getSnapshot
        .mockResolvedValueOnce({
          data: snapshot,
          pendingEscapeTailAnsi,
          cols: 120,
          rows: 40,
          seq: snapshotSeq
        })
        .mockResolvedValue({
          data: done,
          cols: 120,
          rows: 40,
          seq: seq + 100
        })
      const pane = createPane(1)
      const isVisibleRef = { current: false }
      const deps = createDeps({ isVisibleRef, startup: { command: 'codex' } })
      const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(6)
      safeFitAndThen.mockClear()
      safeFitAndThen.mockReturnValueOnce({
        completion: fit.promise,
        cancel: vi.fn(() => fit.resolve(false))
      })
      vi.useFakeTimers()
      onData?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      if (name === 'unhide gap') {
        _dispatchPtyModelRestoreNeededForTest({
          id: 'pty-id',
          reason: 'hidden-drop',
          hiddenDropEpisode: 1,
          markerSeq: hidden.length
        })
      }
      isVisibleRef.current = true
      onData?.(firstLive, {
        seq: hiddenData.length + firstLive.length,
        rawLength: firstLive.length
      })
      await flushAsyncTicks(30)
      expect(safeFitAndThen).toHaveBeenCalledTimes(1)
      onData?.(pending, { seq, rawLength })
      if (name === 'unhide gap' || name === 'fresh snapshot gap' || name === 'styled gap') {
        isVisibleRef.current = name === 'unhide gap'
        _dispatchPtyModelRestoreNeededForTest({
          id: 'pty-id',
          reason: name === 'unhide gap' ? 'unhide' : 'hidden-drop',
          hiddenDropEpisode: 1,
          markerSeq: seq + 100
        })
        isVisibleRef.current = true
      }
      await vi.advanceTimersByTimeAsync(750)
      const deadlineOutput = pane.terminal.write.mock.calls.map(([data]) => data).join('')
      expect(deadlineOutput).not.toContain('main recovery was unavailable')
      expect(getSnapshot).toHaveBeenCalledTimes(1)
      let laterOutput = ''
      for (let second = 0; second < 12; second += 1) {
        if (!repaint) {
          const tick = `tick-${second}\r\n`
          laterOutput += tick
          seq += tick.length
          onData?.(tick, { seq, rawLength: tick.length })
        }
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(getSnapshot).toHaveBeenCalledTimes(repaint ? 2 : 1)
      fit.resolve(true)
      await flushAsyncTicks(30)
      await vi.advanceTimersByTimeAsync(2_000)
      await flushAsyncTicks(30)
      const output = pane.terminal.write.mock.calls.map(([data]) => data).join('')
      expect(output).not.toContain('main recovery was unavailable')
      expect(getSnapshot).toHaveBeenCalledTimes(repaint ? 2 : 1)
      disposable.dispose()
      vi.useRealTimers()
      const drained = `${hiddenData}${firstLive}${pending}`
      expect(await renderHeadlessBuffer([output])).toEqual(
        await renderHeadlessBuffer([repaint ? done : drained + laterOutput])
      )
      if (!repaint) {
        expect(await renderHeadlessBuffer([deadlineOutput])).toEqual(
          await renderHeadlessBuffer([drained])
        )
      }
      if (pendingEscapeTailAnsi || style) {
        const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true })
        try {
          await writeHeadlessTerminal(terminal, deadlineOutput)
          const cell = terminal.buffer.active.getLine(1)?.getCell(0)
          if (name === 'styled gap') {
            expect(cell?.isFgDefault()).toBe(true)
          } else {
            expect(cell?.isFgPalette()).toBe(true)
            expect(cell?.getFgColor()).toBe(214)
          }
        } finally {
          terminal.dispose()
        }
      }
    }
  )
})
