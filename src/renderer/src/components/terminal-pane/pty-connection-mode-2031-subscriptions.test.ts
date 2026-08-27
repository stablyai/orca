import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
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

  describe('mode 2031 subscriptions are tracked per raw PTY chunk, never answered', () => {
    async function connectVisiblePane(): Promise<{
      transport: ReturnType<typeof createMockTransport>
      deps: ReturnType<typeof createDeps>
      emit: (data: string, meta?: { droppedOutput?: boolean }) => void
      dispose: () => void
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const captured: {
        current: ((data: string, meta?: { droppedOutput?: boolean }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          captured.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        settings: { ...mockStoreState.settings, theme: 'light' }
      }
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ isVisibleRef: { current: true } })
      const binding = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)
      return {
        transport,
        deps,
        emit: (data: string, meta?: { droppedOutput?: boolean }) => captured.current?.(data, meta),
        dispose: () => binding.dispose()
      }
    }

    const replies = (transport: { sendInput: { mock: { calls: unknown[][] } } }): unknown[] =>
      transport.sendInput.mock.calls.flat().filter((arg) => String(arg).includes('997'))

    it('registers a chunk that ends subscribed, then retires it when the next withdraws', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      // Two separate PTY chunks. xterm would parse both in one batch and see only the net result.
      emit('\x1b[?2031h')
      expect(deps.paneMode2031Ref.current.get(1)).toBe(true)
      emit('\x1b[?2031l')
      expect(deps.paneMode2031Ref.current.get(1)).toBeUndefined()
      expect(replies(transport)).toEqual([])
      dispose()
    })

    it('re-registers a chunk that withdraws and subscribes again', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      emit('\x1b[?2031h')
      emit('\x1b[?2031l\x1b[?2031h')
      expect(deps.paneMode2031Ref.current.get(1)).toBe(true)
      expect(replies(transport)).toEqual([])
      dispose()
    })

    it('registers nothing when one chunk both subscribes and withdraws', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      // The fish prompt case: the subscription is gone before the program could read anything.
      emit('\x1b[?2031h prompt \x1b[?2031l')
      expect(deps.paneMode2031Ref.current.get(1)).toBeUndefined()
      expect(replies(transport)).toEqual([])
      dispose()
    })

    it('registers nothing when the withdrawal is split across two chunks', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      emit('\x1b[?2031h prompt \x1b[?20')
      emit('31l')
      expect(deps.paneMode2031Ref.current.get(1)).toBeUndefined()
      expect(replies(transport)).toEqual([])
      dispose()
    })

    it('registers nothing when an unrelated private mode appends a split withdrawal', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      emit('\x1b[?2031h prompt \x1b[?25')
      emit(';2031l')
      expect(deps.paneMode2031Ref.current.get(1)).toBeUndefined()
      expect(replies(transport)).toEqual([])
      dispose()
    })

    it('registers the subscription once an ambiguous tail resolves to another mode', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      emit('\x1b[?2031h drawing \x1b[?20')
      expect(deps.paneMode2031Ref.current.get(1)).toBeUndefined()
      emit('25h')
      expect(deps.paneMode2031Ref.current.get(1)).toBe(true)
      expect(replies(transport)).toEqual([])
      dispose()
    })

    // One fish prompt cycle, exactly as fish's tty_handoff.rs emits it.
    const FISH_PROMPT_HANDOFF = '\x1b[?2031h\x1b[0m~/orca \x1b[32m❯\x1b[0m \x1b[?2031l'

    it('stays silent across three fish prompts', async () => {
      const { transport, emit, dispose } = await connectVisiblePane()
      emit(FISH_PROMPT_HANDOFF)
      emit(FISH_PROMPT_HANDOFF)
      emit(FISH_PROMPT_HANDOFF)
      expect(replies(transport)).toEqual([])
      dispose()
    })

    it('leaves no stale subscription behind after a fish prompt cycle', async () => {
      const { deps, emit, dispose } = await connectVisiblePane()
      emit(FISH_PROMPT_HANDOFF)
      // A later theme flip must not push CSI 997 at a shell that unsubscribed.
      expect(deps.paneMode2031Ref.current.get(1)).toBeUndefined()
      dispose()
    })

    it('registers a TUI that subscribes at the end of a fish prompt chunk', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      emit(`${FISH_PROMPT_HANDOFF}\x1b[?2031h`)
      expect(deps.paneMode2031Ref.current.get(1)).toBe(true)
      expect(replies(transport)).toEqual([])
      dispose()
    })

    it('keeps a subscription whose withdrawal never arrives', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      // A real TUI: subscribe now, unsubscribe minutes later on exit.
      emit('\x1b[?2031h')
      emit('painting the ui')
      expect(deps.paneMode2031Ref.current.get(1)).toBe(true)
      expect(replies(transport)).toEqual([])
      dispose()
    })

    it('drops a live subscription when a later chunk withdraws it', async () => {
      const { deps, emit, dispose } = await connectVisiblePane()
      // A TUI that exits: the earlier chunk really did register, so the withdrawal has
      // state to undo — otherwise a theme flip pushes CSI 997 at the shell that replaced it.
      emit('\x1b[?2031h')
      expect(deps.paneMode2031Ref.current.get(1)).toBe(true)
      emit('\x1b[?2031l')
      expect(deps.paneMode2031Ref.current.get(1)).toBeUndefined()
      expect(deps.paneLastThemeModeRef.current.get(1)).toBeUndefined()
      dispose()
    })

    it('discards a half-read escape prefix when the pane swaps PTYs', async () => {
      const { transport, deps, emit, dispose } = await connectVisiblePane()
      // Why: the tail is a byte range from the old stream. Splicing it onto the first
      // chunk of a replacement PTY fabricates a subscribe no program ever sent.
      transport.serializeBuffer = vi.fn().mockResolvedValue(null)
      emit('\x1b[?20')
      // droppedOutput latches the hidden-restore PTY id, which is what detects the swap.
      emit('', { droppedOutput: true })
      transport.getPtyId.mockReturnValue('pty-id-2')

      emit('31h')

      expect(deps.paneMode2031Ref.current.get(1)).toBeUndefined()
      expect(replies(transport)).toEqual([])
      dispose()
    })
  })

  it('records hidden Codex mode 2031 subscribes split across becoming visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: { ...mockStoreState.settings, theme: 'light' }
    }

    const isVisibleRef = { current: false }
    const paneMode2031Ref = { current: new Map<number, boolean>() }
    const paneLastThemeModeRef = { current: new Map<number, 'dark' | 'light'>() }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        paneMode2031Ref,
        paneLastThemeModeRef,
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[?20')
    isVisibleRef.current = true
    capturedDataCallback.current?.('31h')

    expect(transport.sendInputImmediate).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
    expect(paneMode2031Ref.current.get(1)).toBe(true)
    // Seeded so the next appearance re-apply only pushes on a real color-mode flip.
    expect(paneLastThemeModeRef.current.get(1)).toBe('light')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('31h', expect.any(Function))

    binding.dispose()
  })

  it('does not keep mode 2031 subscribed when a skipped hidden chunk unsubscribes last', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const paneMode2031Ref = { current: new Map<number, boolean>() }
    const paneLastThemeModeRef = { current: new Map<number, 'dark' | 'light'>() }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        paneMode2031Ref,
        paneLastThemeModeRef,
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[?2031h\x1b[?2031l')

    expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
    expect(paneMode2031Ref.current.has(1)).toBe(false)
    expect(paneLastThemeModeRef.current.has(1)).toBe(false)

    binding.dispose()
  })
})
