import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createKeyboardEventTarget,
  keyEvent,
  sendTerminalInputThroughPane
} from './pty-connection-test-dom'
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

  it('does not enumerate every worktree tab for ordinary input without Codex restart notices', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-live')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {}
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('uses the current worktree tab for Codex stale fallback without enumerating all worktrees', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {
        'pty-other': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('blocks stale Codex fallback input from the current worktree tab without enumerating all worktrees', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('restores input to a Codex pane whose restart notice the user dismissed', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-live')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }] },
      ptyIdsByTabId: { 'tab-1': ['pty-live'] },
      // Why: the record survives a dismissal as launch-account memory, so the
      // input gate has to read the marker rather than the record's existence.
      codexRestartNoticeByPtyId: {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B', dismissed: true }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('restores input through the tab fallback when the dismissed pane has no live PTY binding', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }] },
      ptyIdsByTabId: { 'tab-1': ['pty-live'] },
      codexRestartNoticeByPtyId: {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B', dismissed: true }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('keeps a dismissed split pane typing while a sibling still holds the prompt', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-dismissed')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      // Why: `tab.ptyId` is whichever pane bound last, so a sibling's unanswered
      // notice would otherwise kill this pane's keyboard with no prompt of its own.
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-sibling' }] },
      ptyIdsByTabId: { 'tab-1': ['pty-dismissed', 'pty-sibling'] },
      codexRestartNoticeByPtyId: {
        'pty-dismissed': { previousAccountLabel: 'A', nextAccountLabel: 'B', dismissed: true },
        'pty-sibling': { previousAccountLabel: 'A', nextAccountLabel: 'C' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps({
      // Why: the sibling already holds `tab.ptyId`, which is what makes this a
      // split rather than this pane adopting the tab's binding.
      paneTransportsRef: { current: new Map([[2, createMockTransport('pty-sibling')]]) }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect((transport.getPtyId as unknown as () => string | null)()).toBe('pty-dismissed')
    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('keeps blocking a pane with its own unanswered notice next to a dismissed sibling', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-stale')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-sibling' }] },
      ptyIdsByTabId: { 'tab-1': ['pty-stale', 'pty-sibling'] },
      codexRestartNoticeByPtyId: {
        'pty-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' },
        'pty-sibling': { previousAccountLabel: 'A', nextAccountLabel: 'B', dismissed: true }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps({
      paneTransportsRef: { current: new Map([[2, createMockTransport('pty-sibling')]]) }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect((transport.getPtyId as unknown as () => string | null)()).toBe('pty-stale')
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('keeps a bound pane with no notice typing while a sibling holds a queued restart', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-plain-shell')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      // Why: a requested restart hides the prompt, so blocking this record-less
      // pane through `tab.ptyId` would leave a dead keyboard and nothing to answer.
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-sibling' }] },
      ptyIdsByTabId: { 'tab-1': ['pty-plain-shell', 'pty-sibling'] },
      codexRestartNoticeByPtyId: {
        'pty-sibling': { previousAccountLabel: 'A', nextAccountLabel: 'B', restartRequested: true }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps({
      paneTransportsRef: { current: new Map([[2, createMockTransport('pty-sibling')]]) }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect((transport.getPtyId as unknown as () => string | null)()).toBe('pty-plain-shell')
    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('keeps blocking input on a pane whose restart is requested but not yet run', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-live')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }] },
      ptyIdsByTabId: { 'tab-1': ['pty-live'] },
      // Why: unlike a dismissal, a queued restart leaves the pane running under
      // the old account until it actually relaunches.
      codexRestartNoticeByPtyId: {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B', restartRequested: true }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('blocks input to stale Codex panes until they restart', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const transport = createMockTransport('pty-codex-stale')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-codex-stale' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-codex-stale']
      },
      codexRestartNoticeByPtyId: {
        'pty-codex-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      },
      agentStatusByPaneKey: {
        [makePaneKey('tab-1', LEAF_1)]: {
          paneKey: makePaneKey('tab-1', LEAF_1),
          state: 'working',
          prompt: 'stale input',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          stateHistory: []
        }
      }
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    const sendTerminalInput = onDataHandler as (data: string) => void
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    sendTerminalInput('\x03')
    vi.advanceTimersByTime(500)

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer interrupts when mobile presence lock blocks terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const ptyId = 'pty-mobile-locked'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] },
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            state: 'working',
            prompt: 'locked input',
            updatedAt: 1_000,
            stateStartedAt: 900,
            agentType: 'codex',
            stateHistory: []
          }
        }
      }

      const pane = createPane(1)
      const terminalTarget = createKeyboardEventTarget()
      ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
      ;(onDataHandler as unknown as (data: string) => void)('\x03')
      ;(onDataHandler as unknown as (data: string) => void)('x')
      vi.advanceTimersByTime(500)

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('drops xterm protocol replies from live TUI output while mobile presence lock is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    const ptyId = 'pty-mobile-tui-query'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] }
      }

      const pane = createPane(1)
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      // Simulate xterm answering a TUI's DA1 query while the phone owns the PTY.
      ;(onDataHandler as unknown as (data: string) => void)('\x1b[?1;2c')
      // Capability handlers are registered outside onData and must honor the same mobile query-authority lock.
      const csiCalls = (
        pane.terminal.parser.registerCsiHandler as unknown as {
          mock: { calls: [{ final: string }, (params: (number | number[])[]) => boolean][] }
        }
      ).mock.calls
      const da1Handler = csiCalls.find(([id]) => id.final === 'c')?.[1]
      expect(da1Handler).toBeTypeOf('function')
      da1Handler?.([])
      await flushAsyncTicks()

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(transport.sendInputImmediate).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('blocks remote locked terminal input before it reaches the runtime transport', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    const ptyId = 'remote:env-1@@terminal-1'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] }
      }

      const pane = createPane(1)
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      ;(onDataHandler as unknown as (data: string) => void)('x')
      await flushAsyncTicks()

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('does not infer interrupts when the transport rejects terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const transport = createMockTransport('pty-disconnected')
    transport.sendInput.mockReturnValue(false)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'working',
      prompt: 'disconnected input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      stateHistory: []
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    vi.advanceTimersByTime(500)

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer interrupts when the main process rejects acknowledged input', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const transport = createMockTransport('pty-mobile-race')
    transport.sendInputAccepted = vi.fn().mockResolvedValue(false)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'working',
      prompt: 'mobile race input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      stateHistory: []
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)

    expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x03')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('remounts a connected pane when main reports its daemon write unavailable', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { _resetTerminalPaneRecoveryForTests } = await import('./terminal-pane-recovery')
    _resetTerminalPaneRecoveryForTests()
    const remountTerminalTabForRecovery = vi.fn<(tabId: string) => boolean>(() => true)
    mockStoreState = { ...mockStoreState, remountTerminalTabForRecovery } as StoreState
    const transport = createMockTransport('daemon-pty')
    let writeUnavailable: (() => void) | undefined
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      writeUnavailable = callbacks.onWriteUnavailable
      return { id: 'daemon-pty' }
    })
    transportFactoryQueue.push(transport)

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(6)
    writeUnavailable?.()
    await flushAsyncTicks(6)

    expect(window.api.pty.hasPty).toHaveBeenCalledWith('daemon-pty')
    expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
    _resetTerminalPaneRecoveryForTests()
  })

  it('quarantines the interrupted line after a write-unavailable remount, but never device replies', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { _resetTerminalPaneRecoveryForTests } = await import('./terminal-pane-recovery')
    _resetTerminalPaneRecoveryForTests()
    const remountTerminalTabForRecovery = vi.fn<(tabId: string) => boolean>(() => true)
    mockStoreState = { ...mockStoreState, remountTerminalTabForRecovery } as StoreState
    const transport = createMockTransport('daemon-pty')
    let writeUnavailable: (() => void) | undefined
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      writeUnavailable = callbacks.onWriteUnavailable
      return { id: 'daemon-pty' }
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(6)
    writeUnavailable?.()
    await flushAsyncTicks(6)
    expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')

    // The surviving tail of `echo hi; rm -rf x`: reaching the fresh shell would
    // let the user's own Enter run `rm -rf x` (#10065 follow-up).
    sendTerminalInputThroughPane(pane, 'cho hi; rm -rf x')
    expect(transport.sendInput).not.toHaveBeenCalledWith('cho hi; rm -rf x')
    // A program that queries during reattach hangs if its reply is dropped.
    sendTerminalInputThroughPane(pane, '\x1b[3;1R')
    expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[3;1R')
    sendTerminalInputThroughPane(pane, '\r')
    expect(transport.sendInput).not.toHaveBeenCalledWith('\r')
    // The terminator disarmed it, so the next real command reaches the shell.
    sendTerminalInputThroughPane(pane, 'ls\r')
    expect(transport.sendInput).toHaveBeenCalledWith('ls\r')
    _resetTerminalPaneRecoveryForTests()
  })

  it('recovers a wedged write pipeline after accepted input without renderer output', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const { settleTerminalWriteStallWatch, WRITE_PIPELINE_STALL_CHECK_MS } =
      await import('@/lib/pane-manager/terminal-write-pipeline-health')
    const remountTerminalTabForRecovery = vi.fn<(tabId: string) => boolean>(() => true)
    mockStoreState = { ...mockStoreState, remountTerminalTabForRecovery } as StoreState
    const transport = createMockTransport('pty-wedged')
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    pane.terminal.write.mockClear()
    pane.terminal.write.mockImplementation(() => {})

    sendTerminalInputThroughPane(pane, 'x')
    settleTerminalWriteStallWatch(pane.terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 2)
    await flushAsyncTicks()

    expect(transport.sendInput).toHaveBeenCalledWith('x')
    expect(pane.terminal.write).toHaveBeenCalledWith('', expect.any(Function))
    expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
    binding.dispose()
  })

  it('does not arm the wedge probe when acknowledged input is rejected', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const { WRITE_PIPELINE_STALL_CHECK_MS } =
      await import('@/lib/pane-manager/terminal-write-pipeline-health')
    const transport = createMockTransport('pty-rejected')
    transport.sendInputAccepted = vi.fn().mockResolvedValue(false)
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    pane.terminal.write.mockClear()
    pane.terminal.write.mockImplementation(() => {})

    sendTerminalInputThroughPane(pane, '\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 2)
    await flushAsyncTicks()

    expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x03')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('', expect.any(Function))
    binding.dispose()
  })

  it('blocks input when tab-level ptyId is stale even if panePtyId is null', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-level-pty' }]
      },
      codexRestartNoticeByPtyId: {
        'tab-level-pty': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('hello')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })
})
