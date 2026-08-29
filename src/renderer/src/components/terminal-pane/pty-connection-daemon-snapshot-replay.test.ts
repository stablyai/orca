import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_DEAD_TUI_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_GRAPHIC_RENDITION
} from '../../../../shared/terminal-mode-reset-profiles'
import { Terminal } from '@xterm/headless'
import { flushAsyncTicks, createDeferred, writeHeadlessTerminal } from './pty-connection-test-async'
import { createRect } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
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

  it('clears the captured pen for a normal-buffer fallback reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    const snapshot = 'ORCA-SGR-REPRO \x1b[1mBOLD-RUN-LEFT-OPEN\x1b[1;34H'
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      },
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      `${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[3J\x1b[H`,
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      `${RESET_GRAPHIC_RENDITION}${snapshot}`,
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      POST_REPLAY_REATTACH_RESET,
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      POST_REPLAY_MODE_RESET,
      expect.any(Function)
    )

    const rendered = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    try {
      await writeHeadlessTerminal(rendered, '\x1b[1;44mDIRTY')
      for (const [data] of pane.terminal.write.mock.calls) {
        if (data) {
          await writeHeadlessTerminal(rendered, data)
        }
      }
      await writeHeadlessTerminal(rendered, 'PLAIN')
      const line = rendered.buffer.active.getLine(rendered.buffer.active.baseY)
      const plainColumn = line?.translateToString(true).indexOf('PLAIN') ?? -1

      expect(line?.getCell(plainColumn)?.isBold()).toBe(0)
      expect(line?.getCell(plainColumn)?.getFgColor()).toBe(-1)
      expect(line?.getCell(plainColumn)?.getBgColor()).toBe(-1)
      expect(rendered.buffer.active.getLine(5)?.getCell(39)?.getBgColor()).toBe(-1)
    } finally {
      rendered.dispose()
    }
  })

  it('returns a shell-owned daemon snapshot to the normal buffer on reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId
        ? {
            id: sessionId,
            snapshot: '\x1b[?1049h\x1b[?1003hSTALE-TUI',
            isAlternateScreen: true,
            snapshotTerminalOwner: 'shell'
          }
        : null
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState

    const pane = createPane(1)
    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      }) as never
    )
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      POST_REPLAY_DEAD_TUI_RESET,
      expect.any(Function)
    )
  })

  it('drops a too-wide daemon alt frame and keeps the scrollback prefix', async () => {
    // Why: fixed-grid alt rows clip at a narrower viewport until the owner repaints.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: 'PREFIX-SCROLLBACK' + 'ALT-FRAME-BODY',
          snapshotPrefixAnsi: 'PREFIX-SCROLLBACK',
          snapshotFrameAnsi: 'ALT-FRAME-BODY',
          snapshotFrameRestoreAnsi: 'RESTORE-LIVE-STATE',
          snapshotCols: 200,
          snapshotRows: 50,
          isAlternateScreen: true
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState

    const pane = createPane(1)
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }))
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(writes.join('')).toContain('PREFIX-SCROLLBACK')
    expect(writes.join('')).toContain('RESTORE-LIVE-STATE')
    expect(writes.join('')).not.toContain('ALT-FRAME-BODY')
  })

  it('keeps a daemon alt frame at its capture grid while the target grid is unknown', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId
        ? {
            id: sessionId,
            snapshot: 'PREFIX-SCROLLBACK' + 'ALT-FRAME-BODY',
            snapshotPrefixAnsi: 'PREFIX-SCROLLBACK',
            snapshotFrameAnsi: 'ALT-FRAME-BODY',
            snapshotFrameRestoreAnsi: 'RESTORE-LIVE-STATE',
            snapshotCols: 120,
            snapshotRows: 40,
            isAlternateScreen: true
          }
        : null
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState

    const pane = createPane(1)
    pane.container.getBoundingClientRect = vi.fn(() => createRect(0, 0))
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 1, rows: 1 }))
    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      }) as never
    )
    await flushAsyncTicks(20)

    const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(writes.join('')).toContain('PREFIX-SCROLLBACK')
    expect(writes.join('')).toContain('ALT-FRAME-BODY')
    expect(writes.filter((write) => write.includes('ALT-FRAME-BODY'))).toHaveLength(1)
  })

  it('falls back to the merged daemon snapshot when split metadata is incomplete', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId
        ? {
            id: sessionId,
            snapshot: 'LEGACY-MERGED-SNAPSHOT',
            snapshotPrefixAnsi: 'INCOMPLETE-PREFIX',
            snapshotFrameRestoreAnsi: 'RESTORE-LIVE-STATE',
            snapshotCols: 200,
            snapshotRows: 50,
            isAlternateScreen: true
          }
        : null
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState

    const pane = createPane(1)
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }))
    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      }) as never
    )
    await flushAsyncTicks(20)

    const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(writes.join('')).toContain('LEGACY-MERGED-SNAPSHOT')
    expect(writes.join('')).not.toContain('INCOMPLETE-PREFIX')
  })

  it('keeps a daemon alt frame when the pane is not narrower than the capture', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: 'PREFIX-SCROLLBACK' + 'ALT-FRAME-BODY',
          snapshotPrefixAnsi: 'PREFIX-SCROLLBACK',
          snapshotFrameAnsi: 'ALT-FRAME-BODY',
          snapshotFrameRestoreAnsi: 'RESTORE-LIVE-STATE',
          snapshotCols: 120,
          snapshotRows: 40,
          isAlternateScreen: true
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState

    const pane = createPane(1)
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }))
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(
      (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('')
    ).toContain('ALT-FRAME-BODY')
  })

  it('drops a too-wide daemon alt frame on cold restore and keeps its history', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: 'PREFIX-SCROLLBACK' + 'ALT-FRAME-BODY',
          snapshotPrefixAnsi: 'PREFIX-SCROLLBACK',
          snapshotFrameAnsi: 'ALT-FRAME-BODY',
          snapshotFrameRestoreAnsi: 'RESTORE-LIVE-STATE',
          snapshotCols: 200,
          snapshotRows: 50,
          isAlternateScreen: true,
          coldRestore: { scrollback: 'x', cwd: '/tmp' }
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState

    const pane = createPane(1)
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }))
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(writes.join('')).toContain('PREFIX-SCROLLBACK')
    expect(writes.join('')).toContain('RESTORE-LIVE-STATE')
    expect(writes.join('')).not.toContain('ALT-FRAME-BODY')
    expect(writes).toContain(`${RESET_GRAPHIC_RENDITION}PREFIX-SCROLLBACKRESTORE-LIVE-STATE`)
    expect(writes).toContain(POST_REPLAY_MODE_RESET)
  })

  it('resizes the pane to the snapshot grid before replaying daemon snapshot bytes (bug #7279)', async () => {
    // Why: the daemon serializes soft-wrapped lines flat, so reattach must resize xterm to the snapshot grid before writing, or rows rewrap wrong.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: '\x1b[?1004hrestored snapshot',
          snapshotCols: 80,
          snapshotRows: 24
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      }
    } as StoreState

    // createPane opens the pane at 120x40, deliberately different from the daemon snapshot's 80x24 grid.
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    // Pane was resized to the snapshot grid before the snapshot bytes landed.
    expect(pane.terminal.resize).toHaveBeenCalledWith(80, 24)
    const resizeToSnapshotCall = pane.terminal.resize.mock.invocationCallOrder.find(
      (_order, index) => {
        const [cols, rows] = pane.terminal.resize.mock.calls[index]
        return cols === 80 && rows === 24
      }
    )
    const snapshotWriteCall = pane.terminal.write.mock.invocationCallOrder.find(
      (_order, index) =>
        pane.terminal.write.mock.calls[index][0] ===
        `${RESET_GRAPHIC_RENDITION}\x1b[?1004hrestored snapshot`
    )
    expect(resizeToSnapshotCall).toBeDefined()
    expect(snapshotWriteCall).toBeDefined()
    expect(resizeToSnapshotCall as number).toBeLessThan(snapshotWriteCall as number)
  })

  it('waits for a recovered destination fit before forwarding its grid or live output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { safeFit } = await import('@/lib/pane-manager/pane-tree-ops')
    const transport = createMockTransport('tab-pty')
    let deliverLiveData = (_data: string): void => {}
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (callbacks?.onData) {
          deliverLiveData = callbacks.onData
        }
        return sessionId
          ? {
              id: sessionId,
              snapshot: 'source-grid snapshot',
              snapshotCols: 80,
              snapshotRows: 24
            }
          : null
      }
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState
    const pane = createPane(1)
    pane.fitAddon.proposeDimensions = vi.fn(() => undefined) as never
    const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    transport.resize.mockClear()
    signalPty.mockClear()
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }
    await flushAsyncTicks(8)

    expect(transport.resize).not.toHaveBeenCalled()
    expect(signalPty).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')

    deliverLiveData('live-after-snapshot')
    await flushAsyncTicks(4)
    expect(writes.join('')).not.toContain('live-after-snapshot')

    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 })) as never
    safeFit(pane as never)
    await flushAsyncTicks(12)

    expect(transport.resize).toHaveBeenCalledWith(120, 40)
    expect(signalPty).toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
    expect(writes.join('')).toContain('live-after-snapshot')
  })

  it('forwards the destination grid on reveal when the reattach fit was deferred by a display:none pane', async () => {
    // Why: a restored floating-workspace pane reattaches while its panel is still closed, so the
    // pane is display:none for the whole replay. The snapshot pins xterm to the PTY's grid, and the
    // reattach fit is the only step that pushes the client grid back and signals SIGWINCH — losing
    // it strands the PTY at the snapshot grid and the first reveal reflows the replay under a live TUI.
    const { connectPanePty } = await import('./pty-connection')
    const { safeFit } = await import('@/lib/pane-manager/pane-tree-ops')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId
        ? {
            id: sessionId,
            snapshot: 'source-grid snapshot',
            snapshotCols: 80,
            snapshotRows: 24
          }
        : null
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState
    const pane = createPane(1)
    let xtermContainerDisplay = 'none'
    const xtermContainer = new EventTarget() as HTMLElement
    Object.defineProperty(xtermContainer, 'parentElement', { value: null })
    Object.defineProperty(xtermContainer, 'ownerDocument', {
      value: { defaultView: { getComputedStyle: () => ({ display: xtermContainerDisplay }) } }
    })
    ;(pane as { xtermContainer?: HTMLElement }).xtermContainer = xtermContainer
    pane.fitAddon.proposeDimensions = vi.fn(() => undefined) as never
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' },
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    transport.resize.mockClear()
    signalPty.mockClear()

    // Reveal: the panel opens, the pane gains a box, and the first fit becomes measurable.
    xtermContainerDisplay = 'block'
    ;(deps.isVisibleRef as { current: boolean }).current = true
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 })) as never
    safeFit(pane as never)
    await flushAsyncTicks(12)

    expect(transport.resize).toHaveBeenCalledWith(120, 40)
    expect(signalPty).toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
  })

  it('suppresses the deferred reattach grid push when mobile claims the PTY while hidden', async () => {
    // Why: the pre-check at reattach time cannot see a takeover that happens while the pane
    // waits for a box, and this path calls transport.resize directly, bypassing
    // forwardPtyResize's own suppression.
    const { connectPanePty } = await import('./pty-connection')
    const { safeFit } = await import('@/lib/pane-manager/pane-tree-ops')
    const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId
        ? {
            id: sessionId,
            snapshot: 'source-grid snapshot',
            snapshotCols: 80,
            snapshotRows: 24
          }
        : null
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState
    const pane = createPane(1)
    let xtermContainerDisplay = 'none'
    const xtermContainer = new EventTarget() as HTMLElement
    Object.defineProperty(xtermContainer, 'parentElement', { value: null })
    Object.defineProperty(xtermContainer, 'ownerDocument', {
      value: { defaultView: { getComputedStyle: () => ({ display: xtermContainerDisplay }) } }
    })
    ;(pane as { xtermContainer?: HTMLElement }).xtermContainer = xtermContainer
    pane.fitAddon.proposeDimensions = vi.fn(() => undefined) as never
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' },
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    transport.resize.mockClear()
    signalPty.mockClear()

    try {
      // Mobile takes the PTY while the pane is still hidden.
      setFitOverride('tab-pty', 'mobile-fit', 49, 20)

      xtermContainerDisplay = 'block'
      ;(deps.isVisibleRef as { current: boolean }).current = true
      pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 })) as never
      safeFit(pane as never)
      await flushAsyncTicks(12)

      expect(transport.resize).not.toHaveBeenCalledWith(120, 40)
      expect(signalPty).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
    } finally {
      setFitOverride('tab-pty', 'desktop-fit', 0, 0)
    }
  })

  it('restores a pinned viewport only after a same-size reattach snapshot finishes parsing', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId
        ? {
            id: sessionId,
            snapshot: 'same-size authoritative snapshot',
            snapshotCols: 120,
            snapshotRows: 40
          }
        : null
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState
    const pane = createPane(1)
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.buffer.active.viewportY = 80
    markTerminalPinnedViewport(pane.terminal)
    const { parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled()

    // Model xterm's native pinned state after clear+replay: the old line number is meaningless, but distance-from-bottom is preserved.
    pane.terminal.buffer.active.baseY = 200
    pane.terminal.buffer.active.viewportY = 0
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }
    await flushAsyncTicks(8)

    expect(pane.terminal.scrollToLine).toHaveBeenLastCalledWith(180)
    markTerminalFollowOutput(pane.terminal)
  })

  it('does not apply a queued reattach snapshot after the PTY is replaced', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    const reattachResult = createDeferred<{
      id: string
      snapshot: string
    }>()
    const replayCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        replayCallback.current = callbacks?.onReplayData ?? null
        return reattachResult.promise
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(8)
    replayCallback.current?.('blocking replay')
    await flushAsyncTicks(12)
    expect(writes).toEqual(['\x1b[2J\x1b[3J\x1b[H'])
    reattachResult.resolve({ id: 'tab-pty', snapshot: 'stale authoritative snapshot' })
    await flushAsyncTicks(12)
    const resizeCallsBeforeReplacement = transport.resize.mock.calls.length
    vi.mocked(transport.getPtyId).mockReturnValue('replacement-pty')
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(12)

    expect(writes).not.toContain('stale authoritative snapshot')
    expect(transport.resize).toHaveBeenCalledTimes(resizeCallsBeforeReplacement)
    expect(window.api.pty.signal).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
  })

  it('does not apply a queued reattach snapshot after its PTY exits', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    const reattachResult = createDeferred<{ id: string; snapshot: string }>()
    const replayCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(
      async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
        replayCallback.current = callbacks?.onReplayData ?? null
        return reattachResult.promise
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(8)
    replayCallback.current?.('blocking replay')
    await flushAsyncTicks(12)
    reattachResult.resolve({ id: 'tab-pty', snapshot: 'dead authoritative snapshot' })
    await flushAsyncTicks(12)
    const resizeCallsBeforeExit = transport.resize.mock.calls.length
    vi.mocked(transport.getPtyId).mockReturnValue(null)
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(12)

    expect(writes).not.toContain('dead authoritative snapshot')
    expect(transport.resize).toHaveBeenCalledTimes(resizeCallsBeforeExit)
    expect(window.api.pty.signal).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
    expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
  })

  it('drops stale callbacks but delivers fresh replacement output after an old replay clear', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getTerminalScrollIntentKind, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    const oldResult = createDeferred<undefined>()
    const oldCallbacks: { current: ConnectCallbacks | null } = { current: null }
    const replacementCallbacks: { current: ConnectCallbacks | null } = { current: null }
    let connectCount = 0
    transport.connect.mockImplementation(
      async ({ callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        connectCount += 1
        if (connectCount === 1) {
          oldCallbacks.current = callbacks ?? null
          return oldResult.promise
        }
        vi.mocked(transport.getPtyId).mockReturnValue('replacement-pty')
        replacementCallbacks.current = callbacks ?? null
        return 'replacement-pty'
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.viewportY = 80
    pane.terminal.buffer.active.baseY = 100
    markTerminalPinnedViewport(pane.terminal)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(8)
    oldCallbacks.current?.onReplayData?.('old replay')
    await flushAsyncTicks(8)
    parseCallbacks.shift()?.()
    await flushAsyncTicks(8)
    oldCallbacks.current?.onError?.('SSH_SESSION_EXPIRED: tab-pty')
    oldResult.resolve(undefined)
    await flushAsyncTicks(20)
    expect(replacementCallbacks.current).not.toBeNull()

    replacementCallbacks.current?.onData?.('B-PROMPT')
    oldCallbacks.current?.onData?.('STALE-A')
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(20)

    expect(writes).toContain('B-PROMPT')
    expect(writes).not.toContain('STALE-A')
    expect(pane.terminal.scrollToBottom).toHaveBeenCalled()
    expect(getTerminalScrollIntentKind(pane.terminal)).toBe('followOutput')
  })
})
