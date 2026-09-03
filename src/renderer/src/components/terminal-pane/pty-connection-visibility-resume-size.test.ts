import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
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

  describe('PTY size re-assert on visibility resume', () => {
    // Why: a resize dropped while hidden leaves xterm and the PTY diverged, and dedupe hides it; resume re-asserts on real drift.
    async function connectResumablePane(depsOverrides: Record<string, unknown> = {}): Promise<{
      binding: { noteVisibilityResume: () => void }
      transport: MockTransport
      deps: ReturnType<typeof createDeps>
      pane: ReturnType<typeof createPane>
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) },
        ...depsOverrides
      })
      const pane = createPane(2)
      const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
        noteVisibilityResume: () => void
      }
      return { binding, transport, deps, pane }
    }

    function installObservedPane(pane: ReturnType<typeof createPane>): {
      trigger: () => void
      restore: () => void
    } {
      const originalResizeObserver = globalThis.ResizeObserver
      const originalElement = globalThis.Element
      const hadResizeObserver = 'ResizeObserver' in globalThis
      const hadElement = 'Element' in globalThis
      type ResizeObserverCallbackLike = ConstructorParameters<typeof ResizeObserver>[0]
      class MockElement extends EventTarget {
        dataset: Record<string, string> = {}
        classList = { contains: (className: string) => className === 'pane' }

        querySelectorAll(): MockElement[] {
          return []
        }
      }
      class MockResizeObserver {
        static instances: MockResizeObserver[] = []
        observe = vi.fn()
        disconnect = vi.fn()

        constructor(private readonly callback: ResizeObserverCallbackLike) {
          MockResizeObserver.instances.push(this)
        }

        trigger(): void {
          this.callback([], this as never)
        }
      }

      globalThis.Element = MockElement as never
      globalThis.ResizeObserver = MockResizeObserver as never
      pane.container = new MockElement() as unknown as HTMLElement

      return {
        trigger: () => MockResizeObserver.instances[0]?.trigger(),
        restore: () => {
          if (hadResizeObserver) {
            globalThis.ResizeObserver = originalResizeObserver
          } else {
            Reflect.deleteProperty(globalThis, 'ResizeObserver')
          }
          if (hadElement) {
            globalThis.Element = originalElement
          } else {
            Reflect.deleteProperty(globalThis, 'Element')
          }
        }
      }
    }

    it('re-asserts the current size when the PTY drifted from xterm', async () => {
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 80, rows: 24 })
      const { binding, transport } = await connectResumablePane()
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      // xterm is 120x40 (createPane default), PTY reports 80x24 → re-assert.
      expect(transport.resize).toHaveBeenCalledWith(120, 40, { claim: true })
    })

    it('does not fit during visibility-resume reassertion', async () => {
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 80, rows: 24 })
      const { binding, transport, pane } = await connectResumablePane()
      const fit = vi.fn(() => {
        pane.terminal.cols = 132
        pane.terminal.rows = 40
      })
      pane.fitAddon = {
        ...pane.fitAddon,
        fit,
        proposeDimensions: vi.fn(() => ({ cols: 132, rows: 40 }))
      } as never
      Object.defineProperty(pane.container, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: 1130, height: 688 })
      })
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(fit).not.toHaveBeenCalled()
      expect(transport.resize).toHaveBeenCalledWith(120, 40, { claim: true })
    })

    it('re-asserts after observed pane geometry changes while visible', async () => {
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 200, rows: 40 })
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        pane.terminal.cols = 82
        pane.terminal.rows = 40

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        transport.resize.mockClear()
        vi.mocked(window.api.pty.getSize).mockClear()

        observer.trigger()
        await flushAsyncTicks()

        expect(window.api.pty.getSize).toHaveBeenCalledWith('pty-pane-2')
        expect(transport.resize).toHaveBeenCalledWith(82, 40, { claim: true })
      } finally {
        observer.restore()
      }
    })

    it('repairs stale xterm grid drift on foreground output even without a pane resize', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      let proposedGrid = { cols: 62, rows: 63 }
      pane.terminal.cols = 62
      pane.terminal.rows = 63
      pane.fitAddon = {
        ...pane.fitAddon,
        fit: vi.fn(() => {
          pane.terminal.cols = proposedGrid.cols
          pane.terminal.rows = proposedGrid.rows
        }),
        proposeDimensions: vi.fn(() => proposedGrid)
      } as never
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 62, rows: 63 })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      proposedGrid = { cols: 65, rows: 63 }
      vi.mocked(pane.fitAddon.fit).mockClear()
      transport.resize.mockClear()
      vi.mocked(window.api.pty.getSize).mockClear()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('\x1b[?2026hcodex redraw frame')
      await flushAsyncTicks()

      expect(pane.fitAddon.fit).toHaveBeenCalled()
      expect(window.api.pty.getSize).toHaveBeenCalledWith('pty-pane-2')
      expect(transport.resize).toHaveBeenCalledWith(65, 63, { claim: true })
    })

    it('skips foreground grid drift repair while mobile owns the PTY without a fit override', async () => {
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      let proposedGrid = { cols: 62, rows: 63 }
      pane.terminal.cols = 62
      pane.terminal.rows = 63
      pane.fitAddon = {
        ...pane.fitAddon,
        fit: vi.fn(() => {
          pane.terminal.cols = proposedGrid.cols
          pane.terminal.rows = proposedGrid.rows
        }),
        proposeDimensions: vi.fn(() => proposedGrid)
      } as never

      try {
        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        proposedGrid = { cols: 65, rows: 63 }
        setDriverForPty('pty-pane-2', { kind: 'mobile', clientId: 'phone-1' })
        vi.mocked(pane.fitAddon.fit).mockClear()
        transport.resize.mockClear()
        vi.mocked(window.api.pty.getSize).mockClear()
        expect(capturedDataCallback.current).not.toBeNull()

        capturedDataCallback.current?.('\x1b[?2026hcodex redraw frame')
        await flushAsyncTicks()

        expect(pane.fitAddon.fit).not.toHaveBeenCalled()
        expect(window.api.pty.getSize).not.toHaveBeenCalled()
        expect(transport.resize).not.toHaveBeenCalled()
      } finally {
        setDriverForPty('pty-pane-2', { kind: 'idle' })
      }
    })

    it('reports desktop geometry without resizing while a mobile-fit override is active', async () => {
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        pane.fitAddon = {
          ...pane.fitAddon,
          proposeDimensions: vi.fn(() => ({ cols: 101, rows: 33 }))
        } as never

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        setFitOverride('pty-pane-2', 'mobile-fit', 40, 30)
        transport.resize.mockClear()
        vi.mocked(window.api.pty.getSize).mockClear()
        vi.mocked(window.api.pty.reportGeometry).mockClear()

        observer.trigger()
        await flushAsyncTicks()

        expect(window.api.pty.getSize).not.toHaveBeenCalled()
        expect(window.api.pty.reportGeometry).toHaveBeenCalledWith('pty-pane-2', 101, 33)
        expect(transport.resize).not.toHaveBeenCalled()
      } finally {
        setFitOverride('pty-pane-2', 'desktop-fit', 0, 0)
        observer.restore()
      }
    })

    it('updates the claiming desktop xterm before forwarding an observed viewport claim', async () => {
      const originalDocument = globalThis.document
      ;(globalThis as { document?: Document }).document = {
        visibilityState: 'visible',
        hasFocus: vi.fn(() => true)
      } as unknown as Document
      globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0))
        return 1
      })
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        let proposedGrid = { cols: 120, rows: 40 }
        pane.fitAddon = {
          ...pane.fitAddon,
          proposeDimensions: vi.fn(() => proposedGrid)
        } as never

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        observer.trigger()
        await flushAsyncTicks()
        setFitOverride('pty-pane-2', 'remote-desktop-fit', 80, 24)
        proposedGrid = { cols: 70, rows: 30 }
        vi.mocked(pane.terminal.resize).mockClear()
        transport.resize.mockClear()

        observer.trigger()
        await flushAsyncTicks()

        expect(pane.terminal.resize).toHaveBeenCalledWith(70, 30)
        expect(transport.resize).toHaveBeenCalledTimes(1)
        expect(transport.resize).toHaveBeenCalledWith(70, 30, { claim: true })
      } finally {
        setFitOverride('pty-pane-2', 'desktop-fit', 0, 0)
        observer.restore()
        globalThis.document = originalDocument
      }
    })

    it('defers a remote-desktop viewport claim until structural replay completes', async () => {
      const originalDocument = globalThis.document
      ;(globalThis as { document?: Document }).document = {
        visibilityState: 'visible',
        hasFocus: vi.fn(() => true)
      } as unknown as Document
      globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0))
        return 1
      })
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const { beginTerminalScrollIntentBufferRebuild, endTerminalScrollIntentBufferRebuild } =
        await import('@/lib/pane-manager/terminal-scroll-intent-rebuild')
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        let proposedGrid = { cols: 120, rows: 40 }
        pane.fitAddon = {
          ...pane.fitAddon,
          proposeDimensions: vi.fn(() => proposedGrid)
        } as never
        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        observer.trigger()
        await flushAsyncTicks()
        setFitOverride('pty-pane-2', 'remote-desktop-fit', 80, 24)
        proposedGrid = { cols: 70, rows: 30 }
        vi.mocked(pane.terminal.resize).mockClear()
        transport.resize.mockClear()
        beginTerminalScrollIntentBufferRebuild(pane.terminal)

        observer.trigger()
        await flushAsyncTicks()
        expect(pane.terminal.resize).not.toHaveBeenCalled()
        expect(transport.resize).not.toHaveBeenCalled()

        endTerminalScrollIntentBufferRebuild(pane.terminal)
        await flushAsyncTicks()
        expect(pane.terminal.resize).toHaveBeenCalledWith(70, 30)
        expect(transport.resize).toHaveBeenCalledWith(70, 30, { claim: true })
      } finally {
        setFitOverride('pty-pane-2', 'desktop-fit', 0, 0)
        observer.restore()
        globalThis.document = originalDocument
      }
    })

    it('skips observed desktop reassertion while mobile owns the PTY without a fit override', async () => {
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        const fit = vi.fn()
        pane.fitAddon = {
          ...pane.fitAddon,
          fit,
          proposeDimensions: vi.fn(() => ({ cols: 130, rows: 50 }))
        } as never

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        setDriverForPty('pty-pane-2', { kind: 'mobile', clientId: 'phone-1' })
        transport.resize.mockClear()
        fit.mockClear()
        vi.mocked(window.api.pty.getSize).mockClear()
        vi.mocked(window.api.pty.reportGeometry).mockClear()

        observer.trigger()
        await flushAsyncTicks()

        expect(window.api.pty.getSize).not.toHaveBeenCalled()
        expect(window.api.pty.reportGeometry).not.toHaveBeenCalled()
        expect(transport.resize).not.toHaveBeenCalled()
        expect(fit).not.toHaveBeenCalled()
      } finally {
        setDriverForPty('pty-pane-2', { kind: 'idle' })
        observer.restore()
      }
    })

    it('does NOT re-assert when the PTY already matches xterm (no spurious SIGWINCH)', async () => {
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 120, rows: 40 })
      const { binding, transport } = await connectResumablePane()
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(transport.resize).not.toHaveBeenCalled()
    })

    it('re-asserts when the PTY size is unknown (cannot confirm synced)', async () => {
      vi.mocked(window.api.pty.getSize).mockResolvedValue(null)
      const { binding, transport } = await connectResumablePane()
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(transport.resize).toHaveBeenCalledWith(120, 40, { claim: true })
    })

    it('queues re-asserted resizes while pane resize holds are active', async () => {
      const originalCustomEvent = globalThis.CustomEvent
      class MockCustomEvent<T> extends Event {
        detail: T

        constructor(type: string, init: { detail: T }) {
          super(type)
          this.detail = init.detail
        }
      }
      globalThis.CustomEvent = MockCustomEvent as unknown as typeof CustomEvent
      try {
        const { holdPtyResizesForPaneSubtrees, queuePanePtyResizeIfHeld } =
          await import('@/lib/pane-manager/pane-pty-resize-hold')
        vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 80, rows: 24 })
        const { binding, transport, pane } = await connectResumablePane()
        await flushAsyncTicks()
        Object.defineProperty(pane.container, 'classList', {
          configurable: true,
          value: { contains: (className: string) => className === 'pane' }
        })
        Object.defineProperty(pane.container, 'querySelectorAll', {
          configurable: true,
          value: () => []
        })
        const release = holdPtyResizesForPaneSubtrees([pane.container])
        // Prove the fixture uses the same held pane before reassertion overwrites the queued placeholder size.
        expect(queuePanePtyResizeIfHeld(pane.container, 1, 1)).toBe(true)
        transport.resize.mockClear()

        binding.noteVisibilityResume()
        await flushAsyncTicks()

        expect(transport.resize).not.toHaveBeenCalled()

        release.flush()

        expect(transport.resize).toHaveBeenCalledTimes(1)
        expect(transport.resize).toHaveBeenCalledWith(120, 40, { claim: true })
      } finally {
        globalThis.CustomEvent = originalCustomEvent
      }
    })

    it('skips remote-runtime PTYs (their size lives outside the local ptySizes map)', async () => {
      const getSize = vi.mocked(window.api.pty.getSize)
      getSize.mockClear()
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('remote:env-1@@terminal-2')
      transport.getConnectionId.mockReturnValue(null)
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
        noteVisibilityResume: () => void
      }
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      // Never even queries size for a remote pane, and never re-asserts.
      expect(getSize).not.toHaveBeenCalled()
      expect(transport.resize).not.toHaveBeenCalled()
    })

    it('claims a focused visible remote mirror once when its passive fit hold arrives', async () => {
      let documentFocused = true
      ;(globalThis as { document?: Document }).document = {
        visibilityState: 'visible',
        hasFocus: vi.fn(() => documentFocused)
      } as unknown as Document
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const { connectPanePty } = await import('./pty-connection')
      const ptyId = 'remote:env-1@@terminal-visible'
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: ptyId },
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      pane.fitAddon = {
        ...pane.fitAddon,
        proposeDimensions: vi.fn(() => ({ cols: 132, rows: 42 }))
      } as never
      const binding = connectPanePty(pane as never, createManager(2) as never, deps as never)
      await flushAsyncTicks()
      transport.claimViewport.mockClear()

      setFitOverride(ptyId, 'remote-desktop-fit', 10, 4)

      expect(transport.claimViewport).toHaveBeenCalledWith(132, 42)
      setFitOverride(ptyId, 'desktop-fit', 132, 42)
      transport.claimViewport.mockClear()
      setFitOverride(ptyId, 'remote-desktop-fit', 80, 24)
      expect(transport.claimViewport).not.toHaveBeenCalled()

      deps.isVisibleRef.current = false
      binding.syncProcessTracking()
      deps.isVisibleRef.current = true
      binding.noteVisibilityResume()
      expect(transport.claimViewport).toHaveBeenCalledWith(132, 42)

      setFitOverride(ptyId, 'desktop-fit', 132, 42)
      documentFocused = false
      deps.isVisibleRef.current = false
      binding.syncProcessTracking()
      deps.isVisibleRef.current = true
      binding.noteVisibilityResume()
      transport.claimViewport.mockClear()
      setFitOverride(ptyId, 'remote-desktop-fit', 80, 24)
      expect(transport.claimViewport).not.toHaveBeenCalled()

      documentFocused = true
      binding.reassertPtySizeAfterWindowWake()
      expect(transport.claimViewport).toHaveBeenCalledWith(132, 42)

      setFitOverride(ptyId, 'desktop-fit', 132, 42)
      deps.isVisibleRef.current = false
      binding.syncProcessTracking()
      deps.isVisibleRef.current = true
      binding.noteVisibilityResume()
      transport.claimViewport.mockClear()
      setFitOverride(ptyId, 'remote-desktop-fit', 80, 24)
      expect(transport.claimViewport).not.toHaveBeenCalled()

      setFitOverride(ptyId, 'desktop-fit', 132, 42)
      binding.dispose()
    })

    it('does NOT re-assert while a mobile-fit override parks the PTY at phone dims', async () => {
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 80, rows: 24 })
      const { binding, transport } = await connectResumablePane()
      // Park the PTY at phone dims — desktop re-assert must be suppressed.
      setFitOverride('pty-pane-2', 'mobile-fit', 40, 30)
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(transport.resize).not.toHaveBeenCalled()
      setFitOverride('pty-pane-2', 'desktop-fit', 0, 0)
    })

    it('does NOT forward when the pane is hidden again before getSize resolves (stale hop)', async () => {
      // Stale getSize resolving after re-hide must not emit a hidden-tab SIGWINCH (which resets alt-screen TUIs).
      let resolveSize: (v: { cols: number; rows: number } | null) => void = () => {}
      vi.mocked(window.api.pty.getSize).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSize = resolve
          })
      )
      const { binding, transport, deps } = await connectResumablePane()
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      // Pane is hidden again while the size query is still in flight.
      deps.isVisibleRef.current = false
      resolveSize({ cols: 80, rows: 24 }) // drift — would re-assert if visible
      await flushAsyncTicks()

      expect(transport.resize).not.toHaveBeenCalled()
    })

    it('coalesces overlapping resumes into a single size query (re-entrancy guard)', async () => {
      const getSize = vi.mocked(window.api.pty.getSize)
      getSize.mockClear()
      let resolveSize: (v: { cols: number; rows: number } | null) => void = () => {}
      getSize.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSize = resolve
          })
      )
      const { binding } = await connectResumablePane()
      getSize.mockClear()

      // Two rapid resumes before the first query resolves → only one query.
      binding.noteVisibilityResume()
      binding.noteVisibilityResume()
      expect(getSize).toHaveBeenCalledTimes(1)
      resolveSize({ cols: 120, rows: 40 })
      await flushAsyncTicks()
    })
  })
})
